import { spawn } from 'node:child_process';
import { open, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorSetupError } from './adapter';
import { queryControl } from './control';
import { connectorService, startConnectorService } from './service';

export async function waitForConnection(directory: string, options: { timeoutMs?: number; ready?: boolean } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const live = await queryControl(directory, 'status').catch(() => null);
    if (live && (!options.ready || live.status === 'running' && live.runtimeChecks === 'passed')) return live;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new ConnectorSetupError('BACKGROUND_NOT_READY', 'The background connector did not become ready. Enrollment is saved; retry setup with the same state directory. Do not create another token.');
}

/** Multiple Hermes clients attach to the same lock-owning connector. Closing a
 * chat closes only its MCP proxy, never the durable receiving process.
 */
export async function activateConnection(directory: string, runtime: string) {
  const live = await queryControl(directory, 'status').catch(() => null);
  if (live) return live;
  const service = connectorService(directory, { runtime, ...(process.platform === 'win32' ? { user: 'current-account' } : {}) });
  const managed = await readFile(path.join(directory, 'startup-request.json'), 'utf8').then(text => JSON.parse(text)?.managed === true).catch(() => false);
  if (managed) {
    // During setup's relay-to-service handoff, never start an unsupervised
    // competitor just because the service manager hasn't registered it yet.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const owner = await queryControl(directory, 'status').catch(() => null);
      if (owner) return owner;
      if (await lstat(path.join(directory, 'service-registration.json')).catch(() => null)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!await lstat(path.join(directory, 'service-registration.json')).catch(() => null)) throw new ConnectorSetupError('BACKGROUND_NOT_READY', 'Background registration is incomplete. Retry setup with the saved connection; no new token is needed.');
  }
  if (await lstat(service.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    await startConnectorService(directory, runtime);
  } else {
    // Explicit --no-service installations can still use interactive tools. Their
    // durable boot supervisor remains the host owner's responsibility.
    const log = await open(path.join(directory, 'service.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [path.join(directory, 'connector.mjs'), 'start', '--state-dir', directory], {
        cwd: directory, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd]
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await log.close(); }
  }
  return waitForConnection(directory);
}
