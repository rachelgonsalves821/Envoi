import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { ApiError, setCsrfCookieName, setExpectedHuman } from '../src/api';
import type { Agent } from '../src/types';
import { onboardingApi } from '../src/onboarding/api';
import { InstallationsController, newestActiveInstallation } from '../src/onboarding/claim-state';
import { AgentInstallations } from '../src/onboarding/AgentInstallations';
import type { OnboardingApi } from '../src/onboarding/types';

const contract = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
const fixture = (name: string): any => loadContractFixture(contract, `${name}.json`);
const list = fixture('owner-installations').response.body;
const revoked = fixture('owner-installation-revoke').response.body;
const now = () => Date.parse('2026-10-12T12:04:00Z');
const client = (): OnboardingApi => ({ lookup: vi.fn(), approve: vi.fn(), reject: vi.fn(), claims: vi.fn(), withdraw: vi.fn(),
  installations: vi.fn().mockResolvedValue(list), revoke: vi.fn().mockResolvedValue(revoked) });
const presence = contractRegistry.contracts.find(item => item.id === 'a5-presence')!;
const presenceFixtures: any[] = presence.fixtures.map(filename => loadContractFixture(presence, filename));
const ownerAgent = (name: string): Agent => { const body = presenceFixtures.find(entry => entry.id === name).response.body; return Array.isArray(body) ? body[0] : body; };
const agent = ownerAgent('owner-seen-recently');
const render = (controller: InstallationsController, selectedAgent = agent, canManage = true) => renderToStaticMarkup(createElement(AgentInstallations, {
  humanId: 'human_example', inboxId: 'inbox_example', agent: selectedAgent, canManage, onReconnect: vi.fn(), controller
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setExpectedHuman(null); setCsrfCookieName('envoi_csrf'); });

describe('installation API consumes canonical requests', () => {
  it.each([
    ['owner-installations', () => onboardingApi.installations('inbox_example', 'agent_example')],
    ['owner-installation-revoke', () => onboardingApi.revoke('inbox_example', 'agent_example', 'installation_example')]
  ] as const)('%s keeps existing human authentication and request shape', async (name, operation) => {
    const entry = fixture(name); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response.body), { status: entry.response.status }));
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('document', { cookie: 'envoi_csrf=PLACEHOLDER_csrf' }); setExpectedHuman('human_example');
    expect(await operation()).toEqual(entry.response.body); const [path, options] = fetcher.mock.calls[0]; expect(path).toBe(entry.request.path);
    expect(options.method ?? 'GET').toBe(entry.request.method); expect(options.body).toBeUndefined(); expect(options.credentials).toBe('same-origin');
    const headers = new Headers(options.headers); expect(headers.has('authorization')).toBe(false);
    if (entry.request.method === 'POST') expect(headers.get('x-envoi-csrf')).toBe('PLACEHOLDER_csrf');
  });
});

describe('installation UI and state', () => {
  it('preserves every active legacy row and the server-bounded ended rows', async () => {
    const entries = fixture('owner-installations-legacy-several').steps[0].response.body; const api = client(); vi.mocked(api.installations).mockResolvedValue(entries);
    const controller = new InstallationsController(api, 'inbox_example', 'agent_example', now); await controller.load();
    expect(controller.getSnapshot().data).toEqual(entries.installations); const html = render(controller);
    expect(html.match(/>Active installation</g)).toHaveLength(2); expect(html.match(/>Revoke installation<\/button>/g)).toHaveLength(2); expect(html.match(/Legacy installation/g)).toHaveLength(7);
    expect(html).toContain('Ended after refresh replay'); expect(html).toContain('active installation can have expired credentials'); expect(html).not.toContain('credential_family_');
  });
  it('selects the newest active installation for replacement without mutating or capping the list', () => {
    const entries = fixture('owner-installations-legacy-several').steps[0].response.body.installations; const reversed = [...entries].reverse(); const before = structuredClone(reversed);
    expect(newestActiveInstallation(reversed)?.id).toBe(entries[0].id); expect(reversed).toEqual(before);
    expect(newestActiveInstallation(entries.filter((item: any) => item.status === 'ended'))).toBeNull();
  });
  it('renders current and ended installation declarations without claiming operational connectivity', async () => {
    const controller = new InstallationsController(client(), 'inbox_example', 'agent_example', now); await controller.load(); const html = render(controller);
    expect(html).toContain('hermes 0.9.0'); expect(html).toContain('Local helper · Envoi Link'); expect(html).toContain('Replaced'); expect(html).toContain('does not prove the runtime is running');
    expect(html).not.toContain('installation_example'); expect(html).not.toContain('envoi_agent_access_');
  });
  it.each(presenceFixtures.filter(entry => entry.client?.surface === 'owner_ui'))('$id keeps the approved agent/connection label wording', async entry => {
    const controller = new InstallationsController(client(), 'inbox_example', 'agent_example', now); await controller.load();
    const selectedAgent = ownerAgent(entry.id); const html = render(controller, selectedAgent);
    expect(html).toContain(`${entry.client.agentLabel} · ${entry.client.connectionLabel.replace('{relative}', '2 hours ago')}`);
  });
  it('revokes only the selected installation and reloads the authoritative order', async () => {
    const api = client(); const refreshed = { ...list, installations: [revoked.installation, list.installations[1]] };
    vi.mocked(api.installations).mockResolvedValueOnce(list).mockResolvedValueOnce(refreshed);
    const controller = new InstallationsController(api, 'inbox_example', 'agent_example', now); await controller.load(); await controller.revoke('installation_example');
    expect(api.revoke).toHaveBeenCalledWith('inbox_example', 'agent_example', 'installation_example', expect.any(AbortSignal)); expect(api.installations).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().data).toEqual(refreshed.installations); expect(render(controller)).toContain('Revoked');
    expect(agent.status).toBe('active'); expect(agent.address).toBe(ownerAgent('owner-seen-recently').address);
    await controller.revoke('installation_example'); expect(api.revoke).toHaveBeenCalledTimes(1);
  });
  it('retains confirmed revocation when the list refresh fails', async () => {
    const api = client(); vi.mocked(api.installations).mockResolvedValueOnce(list).mockRejectedValueOnce(new TypeError('network offline'));
    const controller = new InstallationsController(api, 'inbox_example', 'agent_example', now); await controller.load(); await expect(controller.revoke('installation_example')).resolves.toBe(true);
    expect(controller.getSnapshot().data?.[0]).toEqual(revoked.installation); expect(controller.getSnapshot().problem?.retryable).toBe(true);
  });
  it('does not confuse installation revoke with a frozen identity', async () => {
    const controller = new InstallationsController(client(), 'inbox_example', 'agent_example', now); await controller.load();
    expect(render(controller, { ...agent, credentialRevoked: true, status: 'revoked', onboardingStatus: 'approved' })).toContain('Reconnect this identity');
    const frozen = { ...agent, status: 'revoked', onboardingStatus: 'revoked' }; const html = render(controller, frozen);
    expect(html).not.toContain('Reconnect this identity'); expect(html).toContain('Quick Connect under Advanced');
  });
  it('shows ended installations projected for a frozen agent', async () => {
    const entries = fixture('owner-installations-frozen-agent').steps[0].response.body; const api = client(); vi.mocked(api.installations).mockResolvedValue(entries);
    const controller = new InstallationsController(api, 'inbox_example', 'agent_frozen', now); await controller.load();
    const html = render(controller, { ...agent, id: 'agent_frozen', status: 'revoked', onboardingStatus: 'revoked' }); expect(html).toContain('Legacy installation'); expect(html).toContain('Revoked'); expect(html).not.toContain('>Revoke installation</button>');
  });
  it('shows no management controls or data to a read-only caller', async () => {
    const controller = new InstallationsController(client(), 'inbox_example', 'agent_example', now); await controller.load(); expect(render(controller, agent, false)).toBe('');
  });
  it('clears private installation rows after account change', async () => {
    const api = client(); vi.mocked(api.revoke).mockRejectedValue(Object.assign(new ApiError('changed', 409, 'ACCOUNT_CHANGED'), fixture('claim-account-changed').response.body));
    const controller = new InstallationsController(api, 'inbox_example', 'agent_example', now); await controller.load(); await controller.revoke('installation_example');
    expect(controller.getSnapshot()).toMatchObject({ data: null, blocked: true }); expect(render(controller)).not.toContain('hermes 0.9.0');
  });
  it('ignores late list data after disposal even if transport ignores abort', async () => {
    const api = client(); let finish!: (value: any) => void; vi.mocked(api.installations).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new InstallationsController(api, 'inbox_example', 'agent_example', now); const pending = controller.load(); const signal = vi.mocked(api.installations).mock.calls[0][2]!;
    controller.dispose(); expect(signal.aborted).toBe(true); finish(list); await pending; expect(controller.getSnapshot().data).toBeNull();
  });
});
