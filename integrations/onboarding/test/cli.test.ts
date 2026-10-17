import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { FileBridgeStore } from '../../agent-bridges/file-store';
vi.mock('../../connector/core', async importOriginal => ({ ...await importOriginal<typeof import('../../connector/core')>(),
  readConnection: vi.fn(async () => ({ apiUrl: 'https://www.envoi-agents.com', runtime: 'hermes', address: 'example@envoi.mail', activationSetup: { completionId: 'completion_fixture', installationId: 'installation_example' } }))
}));
import { readConnection } from '../../connector/core';
import { contractRegistry, loadContractFixture } from '../../contract-fixtures/setup';
import { runLocalLink, selectLocalRuntime } from '../cli';
const origin = 'https://www.envoi-agents.com';
const resolver = () => ({ discover: vi.fn(async () => ({})), preflight: vi.fn(async () => undefined) }) as any;
afterEach(() => vi.restoreAllMocks());
function session() {
  return { address: 'example@envoi.mail', _onboarding: { completionId: 'completion_fixture', installation: { id: 'installation_example' } } } as any;
}
it('keeps polling a private pending setup, then starts the foreground connector after confirmed authenticated completion', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  const helper = vi.fn().mockResolvedValueOnce({ schemaVersion: '1', state: 'pending_approval', claimUrl: origin + '/claim', verificationCode: 'F7KQ-PM4D' })
    .mockResolvedValueOnce({ schemaVersion: '1', state: 'connected' });
  const start = vi.fn(async () => undefined), write = vi.fn(), wait = vi.fn(async () => undefined);
  const result = await runLocalLink(['connect', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: helper, start, write, wait });
  expect(result.state).toBe('connected'); expect(wait).toHaveBeenCalledTimes(1);
  expect(helper.mock.calls[1][0]).toEqual(['resume', origin, '--runtime', 'hermes']);
  expect(write).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/agentApiToken|private.*directory|completion_fixture/);
});
it('restarts an already completed saved connection even when adoption was not invoked again', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  const start = vi.fn(async () => undefined), adopt = vi.fn();
  await runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'paused' }), start, adopt });
  expect(adopt).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
});
it('does not start on status/doctor or when no explicit local confirmation was supplied', async () => {
  const start = vi.fn(async () => undefined);
  for (const command of ['status', 'doctor', 'resume']) {
    await runLocalLink([command, origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: command === 'resume' ? 'confirm_approval' : 'connected' }), start });
  }
  expect(start).not.toHaveBeenCalled();
});
it('refuses token-bearing/unknown arguments before discovering or contacting any runtime', async () => {
  const discover = vi.fn();
  await expect(runLocalLink(['connect', origin, '--token', 'private-never-output'], new AbortController().signal, { resolveAdapter: discover })).rejects.toThrow();
  expect(discover).not.toHaveBeenCalled();
});
it('does not start stale runtime configuration after a mismatched installation completion', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue({ ...session(), _onboarding: { completionId: 'other', installation: { id: 'installation_example' } } });
  const start = vi.fn();
  await expect(runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'connected' }), start })).rejects.toThrow('does not match');
  expect(start).not.toHaveBeenCalled();
});
it('requires explicit choice if both trusted runtimes are ready', async () => {
  await expect(selectLocalRuntime(undefined, resolver)).rejects.toThrow('Choose one runtime');
});
it('keeps the helper bundle and metadata exclusively in its private local package', () => {
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  expect(config).toContain("outDir: 'integrations/onboarding/dist'");
  expect(config).not.toContain("outDir: 'web/");
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.private).toBe(true); expect(pkg.bin['envoi-link']).toBe('./dist/envoi-link.mjs');
});

it('runs the actual private helper engine through canonical registration, confirmation, activation and foreground adoption', async () => {
  const registered = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
  const fromFixture = (name: string) => loadContractFixture(registered, name + '.json') as any;
  const responses = ['routes-available', 'registration-created', 'registration-approved', 'activation-created'].map(fromFixture);
  const status = fromFixture('agent-status-installation').response.body;
  const records = new Map<string, any>();
  const memory = { directory: 'private-runtime-test', lock: (fn: () => any) => fn(), read: async (name: string) => structuredClone(records.get(name) ?? null),
    write: async (name: string, value: any) => { records.set(name, structuredClone(value)); } };
  vi.spyOn(FileBridgeStore.prototype, 'load').mockImplementation(async () => records.get('session.json'));
  vi.mocked(readConnection).mockResolvedValue({ version: 1, apiUrl: origin, runtime: 'hermes', address: status.agent.address, configuration: {},
    agentName: 'Example agent', activationSetup: { completionId: 'activation_7f3c9a1e', installationId: status.installation.id } });
  let now = Date.parse('2026-10-12T12:00:00.000Z');
  const paths: string[] = [], start = vi.fn(async () => undefined), adopt = vi.fn(async () => ({} as any)), write = vi.fn();
  const result = await runLocalLink(['connect', origin, '--runtime', 'hermes'], new AbortController().signal, {
    resolveAdapter: resolver, start, adopt, write, wait: async ms => { now += ms; },
    helperDependencies: { store: memory, now: () => now, randomId: () => 'activation_7f3c9a1e',
      confirm: async (details: any) => { expect(details.approverEmailHint).toBe('o***@example.com'); return true; },
      operationalStatus: async () => status,
      request: async (method: string, requestPath: string, options: any = {}) => {
        const next = responses.shift(); paths.push(requestPath); expect(next).toBeDefined();
        expect(method).toBe(next.request.method); expect(requestPath).toBe(next.request.path);
        if (method === 'POST' && requestPath.endsWith('/activate')) expect(options.body).toEqual(next.request.body);
        return structuredClone(next.response.body);
      }
    }
  });
  expect(result.state).toBe('connected'); expect(adopt).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  expect(paths).not.toContain('/api/agent-enroll'); expect(responses).toHaveLength(0);
  expect(records.get('helper-state.json').bootstrapToken).toBeUndefined();
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/envoi_(reg|agent_access|agent_refresh)_|activation_7f3c9a1e|installation_example|inbox_example/);
});
