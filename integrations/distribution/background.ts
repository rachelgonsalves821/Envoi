import path from 'node:path';
import { connectorService, type ServiceDefinition } from '../connector/service';
import { windowsExecutable } from '../connector/windows';

export type BackgroundAction = 'install' | 'start' | 'stop' | 'restart' | 'uninstall';
type Command = ServiceDefinition['commands'][number];
type DefinitionOptions = NonNullable<Parameters<typeof connectorService>[1]>;
type Step = { kind: 'command'; command: Command } | { kind: 'write_definition' | 'remove_definition' | 'stop_connector' | 'require_stopped' };
export interface BackgroundPlan {
  action: BackgroundAction;
  directory: string;
  runtime: 'hermes' | 'openclaw';
  definition: ServiceDefinition;
  encoding: 'utf8' | 'utf16le';
  steps: Step[];
  startsAt: 'user_login';
  preservesCredentials: true;
}

export function backgroundPlan(action: BackgroundAction, directory: string, options: DefinitionOptions & { runtime: 'hermes' | 'openclaw' }): BackgroundPlan {
  if (!['install', 'start', 'stop', 'restart', 'uninstall'].includes(action) || !['hermes', 'openclaw'].includes(options.runtime)) throw new Error('Unsupported background operation.');
  if (!path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory)) throw new Error('Choose an absolute saved installation directory.');
  const absolute = path.resolve(directory);
  const platform = options.platform ?? process.platform;
  const definition = connectorService(absolute, options);
  const command = (executable: string, args: string[]): Step => ({ kind: 'command', command: { executable, args } });
  let start: Step[];
  let disable: Step[];
  let unregister: Step[];
  if (platform === 'linux') {
    start = [command('systemctl', ['--user', 'enable', '--now', `${definition.name}.service`])];
    disable = [command('systemctl', ['--user', 'disable', '--now', `${definition.name}.service`])];
    unregister = [{ kind: 'remove_definition' }, command('systemctl', ['--user', 'daemon-reload'])];
  } else if (platform === 'darwin') {
    start = [command('launchctl', ['load', '-w', definition.filename])];
    disable = [command('launchctl', ['unload', '-w', definition.filename])];
    unregister = [{ kind: 'remove_definition' }];
  } else if (platform === 'win32') {
    const scheduler = windowsExecutable('schtasks.exe', options.env);
    start = [command(scheduler, ['/Change', '/TN', definition.name, '/ENABLE']), command(scheduler, ['/Run', '/TN', definition.name])];
    disable = [command(scheduler, ['/Change', '/TN', definition.name, '/DISABLE'])];
    unregister = [command(scheduler, ['/Delete', '/TN', definition.name, '/F']), { kind: 'remove_definition' }];
  } else throw new Error('Unsupported service manager.');
  const stopped: Step[] = [...disable, { kind: 'stop_connector' }, { kind: 'require_stopped' }];
  const steps: Step[] = action === 'install'
    ? [{ kind: 'require_stopped' }, { kind: 'write_definition' }, ...definition.commands.map(item => ({ kind: 'command' as const, command: item }))]
    : action === 'start' ? [{ kind: 'require_stopped' }, ...start]
      : action === 'restart' ? [...stopped, ...start]
        : action === 'uninstall' ? [...stopped, ...unregister] : stopped;
  return { action, directory: absolute, runtime: options.runtime, definition, encoding: platform === 'win32' ? 'utf16le' : 'utf8', steps, startsAt: 'user_login', preservesCredentials: true };
}

export interface BackgroundExecutor {
  inspect(directory: string): Promise<{ runtime: string; activated: boolean; definitionInstalled: boolean }>;
  acquireLock(directory: string): Promise<() => Promise<void>>;
  stopConnector(directory: string): Promise<void>;
  command(command: Command): Promise<void>;
  writeDefinition(definition: ServiceDefinition, encoding: BackgroundPlan['encoding']): Promise<void>;
  removeDefinition(filename: string): Promise<void>;
}

export async function executeBackgroundPlan(plan: BackgroundPlan, executor: BackgroundExecutor) {
  const connection = await executor.inspect(plan.directory);
  if (!connection.activated || connection.runtime !== plan.runtime) throw new Error('Complete and confirm the existing installation before background setup.');
  if (plan.action !== 'install' && !connection.definitionInstalled) throw new Error('This installation has no registered background definition.');
  if (plan.action === 'install' && connection.definitionInstalled) throw new Error('Background setup already exists; use its lifecycle controls.');
  for (const step of plan.steps) {
    if (step.kind === 'require_stopped') {
      const release = await executor.acquireLock(plan.directory);
      await release();
    } else if (step.kind === 'stop_connector') await executor.stopConnector(plan.directory);
    else if (step.kind === 'write_definition') await executor.writeDefinition(plan.definition, plan.encoding);
    else if (step.kind === 'remove_definition') await executor.removeDefinition(plan.definition.filename);
    else if (step.kind === 'command') await executor.command(step.command);
  }
  return { state: 'management_commands_completed', action: plan.action, preservesCredentials: true, runtimeReadinessVerified: false };
}
