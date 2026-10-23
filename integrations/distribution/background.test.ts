import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectorService } from '../connector/service';
import { acquireConnectorLock } from '../connector/store';
import { backgroundPlan, executeBackgroundPlan, type BackgroundExecutor } from './background';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const options = { runtime: 'hermes' as const, home: path.resolve('fixture home'), node: process.execPath,
  user: 'S-1-5-21-1-2-3-1001', env: { SystemRoot: 'C:\\Windows' } };

function inertExecutor(installed = true) {
  const calls: string[] = [];
  const executor: BackgroundExecutor = {
    inspect: async () => ({ runtime: 'hermes', activated: true, definitionInstalled: installed }),
    acquireLock: async () => { calls.push('lock'); return async () => { calls.push('unlock'); }; },
    stopConnector: async () => { calls.push('authenticated-stop'); },
    command: async command => { calls.push([command.executable, ...command.args].join(' ')); },
    writeDefinition: async () => { calls.push('write-definition'); },
    removeDefinition: async () => { calls.push('remove-definition'); }
  };
  return { calls, executor };
}

describe('background-operation preparation', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    it(`reuses the exact existing ${platform} service definition`, () => {
      const directory = path.resolve('saved state with spaces');
      const plan = backgroundPlan('install', directory, { ...options, platform });
      expect(plan.definition).toEqual(connectorService(directory, { ...options, platform }));
      expect(plan.definition.contents).toContain('connector.mjs');
      expect(plan.definition.contents).not.toMatch(/session\.json|accessToken|refreshToken/);
      expect(plan.preservesCredentials).toBe(true);
    });

    it(`${platform} restart disables supervision and stops the owner before a new start`, async () => {
      const plan = backgroundPlan('restart', path.resolve('state'), { ...options, platform });
      const { calls, executor } = inertExecutor();
      expect(await executeBackgroundPlan(plan, executor)).toMatchObject({ runtimeReadinessVerified: false });
      const stopping = calls.indexOf('authenticated-stop');
      expect(stopping).toBeGreaterThan(0);
      expect(calls.slice(stopping + 1, stopping + 3)).toEqual(['lock', 'unlock']);
      expect(calls.slice(stopping + 3).length).toBeGreaterThan(0);
      if (platform === 'win32') {
        expect(calls[0]).toContain('/DISABLE');
        expect(calls.at(-1)).toContain('/Run');
        expect(calls.join('\n')).not.toContain('/End');
      }
    });

    it(`${platform} uninstall removes only the supervisor definition after the connector exits`, async () => {
      const { calls, executor } = inertExecutor();
      await executeBackgroundPlan(backgroundPlan('uninstall', path.resolve('state'), { ...options, platform }), executor);
      expect(calls.indexOf('remove-definition')).toBeGreaterThan(calls.indexOf('unlock'));
      expect(calls.join('\n')).not.toMatch(/session\.json|connector\.mjs|rmdir|rm -rf/);
    });
  }

  it('does not execute a service start while the existing connector lock is owned', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-single-owner-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'session.json'), 'PRESERVE_EXISTING_STATE');
    const release = await acquireConnectorLock(directory);
    const { executor, calls } = inertExecutor();
    executor.acquireLock = acquireConnectorLock;
    try {
      await expect(executeBackgroundPlan(backgroundPlan('start', directory, { ...options, platform: 'linux' }), executor)).rejects.toThrow(/already running/);
      expect(calls).toEqual([]);
      expect(await readFile(path.join(directory, 'session.json'), 'utf8')).toBe('PRESERVE_EXISTING_STATE');
    } finally { await release(); }
    await executeBackgroundPlan(backgroundPlan('start', directory, { ...options, platform: 'linux' }), executor);
    expect(calls).toHaveLength(1);
  });

  it('never starts if graceful stop failed or the previous owner has not exited', async () => {
    const failedStop = inertExecutor();
    failedStop.executor.stopConnector = async () => { throw new Error('owner did not stop'); };
    await expect(executeBackgroundPlan(backgroundPlan('restart', path.resolve('state'), { ...options, platform: 'win32' }), failedStop.executor)).rejects.toThrow('owner did not stop');
    expect(failedStop.calls).toHaveLength(1);
    const failedLock = inertExecutor();
    failedLock.executor.acquireLock = async () => { throw new Error('still running'); };
    await expect(executeBackgroundPlan(backgroundPlan('restart', path.resolve('state'), { ...options, platform: 'win32' }), failedLock.executor)).rejects.toThrow('still running');
    expect(failedLock.calls).toHaveLength(2);
  });

  it('requires an activated matching runtime and the correct service lifecycle state', async () => {
    const pending = inertExecutor(false);
    pending.executor.inspect = async () => ({ runtime: 'hermes', activated: false, definitionInstalled: false });
    await expect(executeBackgroundPlan(backgroundPlan('install', path.resolve('state'), { ...options, platform: 'linux' }), pending.executor)).rejects.toThrow(/confirm/);
    expect(pending.calls).toEqual([]);
    const existing = inertExecutor();
    await expect(executeBackgroundPlan(backgroundPlan('install', path.resolve('state'), { ...options, platform: 'linux' }), existing.executor)).rejects.toThrow(/already exists/);
    const missing = inertExecutor(false);
    await expect(executeBackgroundPlan(backgroundPlan('start', path.resolve('state'), { ...options, platform: 'linux' }), missing.executor)).rejects.toThrow(/no registered/);
    expect(existing.calls.concat(missing.calls)).toEqual([]);
  });

  it('refuses relative paths and control characters before making a definition', () => {
    expect(() => backgroundPlan('start', 'relative', options)).toThrow(/absolute/);
    expect(() => backgroundPlan('start', path.resolve('state') + '\nextra', options)).toThrow(/absolute/);
  });
});
