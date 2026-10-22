import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('OpenClaw hosted entry point', () => {
  it('does not start a runtime when imported', async () => {
    const write = vi.spyOn(process.stderr, 'write');
    const previousExitCode = process.exitCode;
    try {
      await import('./run');
      await new Promise(resolve => setImmediate(resolve));
      expect(write).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(previousExitCode);
    } finally { write.mockRestore(); }
  });

  it('refuses a second launcher for one connection before opening a bridge', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-entry-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'connector.lock'), JSON.stringify({ pid: process.pid, nonce: 'live-owner' }));
    vi.stubEnv('ENVOI_API_URL', 'https://envoi.example');
    vi.stubEnv('ENVOI_STATE_DIR', directory);
    vi.stubEnv('OPENCLAW_GATEWAY_URL', 'http://127.0.0.1:18762');
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'private-test-token');
    vi.stubEnv('OPENCLAW_AGENT_ID', 'test-agent');
    vi.stubEnv('ENVOI_SCOPED_TOOLS', 'true');
    const { runOpenClaw } = await import('./run');
    await expect(runOpenClaw()).rejects.toThrow('already running');
    expect(await import('node:fs/promises').then(fs => fs.readFile(path.join(directory, 'connector.lock'), 'utf8')))
      .toContain('live-owner');
  });
});
