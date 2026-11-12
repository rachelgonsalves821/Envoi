import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';
import { setExpectedHuman } from '../src/api';
import { ConsentController } from '../src/onboarding/consent-state';
import type { RemoteAuthApi } from '../src/onboarding/remote-auth-types';
import * as validators from '../src/onboarding/remote-auth.validator.mjs';
import { savedSetupApi, savedSetupStage, watchSavedSetup, type SavedSetup } from '../src/onboarding/saved-setup';

const root = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const registry = loadContractRegistry(root);
const contract = registry.contracts.find(entry => entry.id === 'agent-saved-setup');
const fixture = (name: string) => loadContractFixture(contract!, name + '.json', root) as any;
const receive = 'receive_agent_messages' as const;
const send = 'send_agent_messages' as const;
const createdAt = '2026-11-12T15:00:00.000Z';
const expiresAt = '2026-11-12T15:30:00.000Z';
const identity = { name: 'Milo', address: 'milo@envoi-agents.com' };
const preferences = {
  ...identity, setupId: 'setup_example_1', workspaceInboxId: 'inbox_workspace_example',
  workspaceName: 'Example workspace', localPart: 'milo', permissions: [receive, send], expiresAt
};
const waiting: SavedSetup = { ...preferences, runtime: 'dots', createdAt, status: 'waiting' };
const approved: SavedSetup = { ...waiting, status: 'approved', agent: identity };
const connected: SavedSetup = { ...waiting, status: 'connected', agent: { ...identity, id: 'agent_milo', lastSeenAt: null }, effectivePermissions: [receive] };
const ready: SavedSetup = { ...connected, agent: { ...connected.agent, lastSeenAt: '2026-11-12T15:03:00.000Z' } };
const view = {
  client: { name: 'Assistant', clientIdHost: 'assistant.example', redirectHost: 'assistant.example', loopbackRedirect: false, registration: 'metadata_document' },
  connectionRoute: 'remote_mcp_oauth', requestedPermissions: [receive], grantablePermissions: [receive], expiresAt,
  savedSetup: { ...preferences, notRequested: [send], addressAvailable: true }
};
const response = {
  redirectTo: 'https://assistant.example/callback?code=envoi_oauth_code_PLACEHOLDER&state=test&iss=https%3A%2F%2Fwww.envoi-agents.com',
  registrationId: 'registration_example', target: 'new_agent', workspaceName: preferences.workspaceName, agent: identity,
  effectivePermissions: [receive], policyProfile: 'default', codeExpiresAt: expiresAt,
  savedSetup: { setupId: preferences.setupId, linked: true }
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setExpectedHuman(null); });

it('saves and reads setup with the existing owner session transport', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(waiting)));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('document', { cookie: 'envoi_csrf=fixture_csrf' });
  setExpectedHuman('human_example');
  const input = { name: identity.name, localPart: preferences.localPart, permissions: preferences.permissions };
  await expect(savedSetupApi.create(preferences.workspaceInboxId, input)).resolves.toEqual(waiting);
  await expect(savedSetupApi.status(preferences.workspaceInboxId, preferences.setupId)).resolves.toEqual(waiting);
  const [collection, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(collection).toBe('/api/inboxes/inbox_workspace_example/agent-setups');
  expect(options.credentials).toBe('same-origin');
  expect(new Headers(options.headers).get('x-envoi-csrf')).toBe('fixture_csrf');
  expect(new Headers(options.headers).get('x-envoi-expected-human')).toBe('human_example');
  expect(JSON.parse(String(options.body))).toEqual({ runtime: 'dots', ...input });
  expect(fetcher.mock.calls[1][0]).toBe(collection + '/setup_example_1');
  await expect(savedSetupApi.status(preferences.workspaceInboxId, 'setup_other')).rejects.toThrow('different setup');
});

it('polls serially in five-second intervals and marks Ready only after the first authenticated call', async () => {
  vi.useFakeTimers();
  let first!: (setup: SavedSetup) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<SavedSetup>(resolve => { first = resolve; }))
    .mockResolvedValueOnce(connected).mockResolvedValueOnce(ready);
  const onStatus = vi.fn();
  const stop = watchSavedSetup({ request: read, onStatus, onUnavailable: vi.fn() });
  await vi.advanceTimersByTimeAsync(4999);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5001);
  expect(read).toHaveBeenCalledTimes(1);
  first(approved);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(onStatus.mock.calls.map(([setup]) => savedSetupStage(setup))).toEqual(['approved', 'connected', 'ready']);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(read).toHaveBeenCalledTimes(3);
  stop();
});

it.each([{ ...waiting, status: 'expired', reason: 'approval_lapsed' }, { ...waiting, status: 'replaced' }] as const)(
  'stops polling at $status', async setup => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(setup);
    watchSavedSetup({ request: read, onStatus: vi.fn(), onUnavailable: vi.fn() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(1);
  }
);

it('aborts the active status read when the wizard closes', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  let finish!: (setup: SavedSetup) => void;
  const onStatus = vi.fn();
  const stop = watchSavedSetup({
    request: value => { signal = value; return new Promise(resolve => { finish = resolve; }); },
    onStatus, onUnavailable: vi.fn()
  });
  await vi.advanceTimersByTimeAsync(5_000);
  stop();
  finish(ready);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(signal.aborted).toBe(true);
  expect(onStatus).not.toHaveBeenCalled();
});

it('accepts valid extensions while retaining the closed OAuth validators', () => {
  expect(validators.consentView(view)).toBe(true);
  expect(validators.consentView({ ...view, client: {} })).toBe(false);
  expect(validators.consentView({ ...view, decision: { status: 'denied' } })).toBe(false);
  expect(validators.consentView({ ...view, connectionRoute: 'provider_connector' })).toBe(false);
  expect(validators.consentApproveRequest({ target: {}, policyProfile: 'default', grantedPermissions: [receive], savedSetupId: preferences.setupId })).toBe(false);
  expect(validators.consentApproved(response)).toBe(true);
  expect(validators.consentApproved({ ...response, policyProfile: 'custom' })).toBe(false);
  expect(validators.savedSetup(connected)).toBe(true);
  expect(validators.savedSetup({ ...connected, effectivePermissions: [] })).toBe(false);
});

it.each([true, false])('approves the selected grant when the saved setup linked value is %s', async linked => {
  const approve = vi.fn().mockResolvedValue({ ...response, savedSetup: { ...response.savedSetup, linked } });
  const client = { view: vi.fn().mockResolvedValue(view), approve } as unknown as RemoteAuthApi;
  const navigate = vi.fn();
  const controller = new ConsentController('fixture_handle', client, navigate, () => Date.parse(createdAt));
  expect(await controller.load()).toBe(true);
  const target = { kind: 'new_agent', workspaceInboxId: preferences.workspaceInboxId, name: identity.name, localPart: preferences.localPart } as const;
  const body = { target, savedSetupId: preferences.setupId, grantedPermissions: [receive], policyProfile: 'default' } as const;
  expect(await controller.approve({ ...body, grantedPermissions: [receive, send] })).toBe(false);
  expect(await controller.approve({ ...body, grantedPermissions: [receive] })).toBe(true);
  expect(approve).toHaveBeenCalledExactlyOnceWith('fixture_handle', body, expect.any(AbortSignal));
  expect(navigate).toHaveBeenCalledExactlyOnceWith(response.redirectTo);
});

// Before the server PR lands, CI exercises the cases above. Reviewers can
// point at its canonical registry with ENVOI_CONTRACT_FIXTURES_ROOT.
if (contract) it('consumes the published Phase 2b fixtures', () => {
  for (const file of contract.fixtures) {
    const entry = fixture(file.replace(/\.json$/, ''));
    const body = entry.response.body;
    if (entry.response.schema === 'savedSetup') expect(validators.savedSetup(body), file).toBe(true);
    if (entry.response.schema === 'consentViewWithSavedSetup') expect(validators.consentView(body), file).toBe(true);
    if (entry.response.schema === 'consentApprovedWithSavedSetup') expect(validators.consentApproved(body), file).toBe(true);
    if (entry.request.schema === 'consentApproveRequestWithSavedSetup') expect(validators.consentApproveRequest(entry.request.body), file).toBe(true);
  }
});
