import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { AgentCard } from '../src/App';
import type { Agent, Inbox } from '../src/types';
import { ConnectPage } from '../src/onboarding/ConnectPage';
import { claimSignInPath, connectionOffer, connectionPrompt, readConnectionOffer } from '../src/onboarding/connect-state';
import { ApiError, request, setExpectedHuman } from '../src/api';
const contract = contractRegistry.contracts.find(value => value.id === 'agent-registration')!;
const fixture = (name: string) => loadContractFixture(contract, name + '.json') as any;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setExpectedHuman(null); });
describe('approved onboarding connection content', () => {
  it.each(['routes-disabled', 'routes-available', 'routes-available-rest'])('renders only the server-offered local milestone from %s', name => {
    const body = fixture(name).response.body;
    const offer = connectionOffer(body);
    const html = renderToStaticMarkup(createElement(ConnectPage, { initialAvailability: body }));
    expect(offer.localHelper).toBe(name !== 'routes-disabled');
    expect(html.includes('envoi-link connect')).toBe(offer.localHelper);
    expect(html.includes('href="/claim"')).toBe(offer.localHelper);
    expect(html).not.toMatch(/OAuth|provider.connector|on.demand.*connect|access.token_[A-Za-z]/i);
    if (offer.localHelper) {
      expect(html).toContain('masked approver email'); expect(html).toContain('Keep the helper running');
      expect(html).toContain('Never paste access or refresh tokens');
    }
  });
  it('fails closed for unavailable, malformed, incomplete and unsupported route snapshots', () => {
    const valid = fixture('routes-available').response.body;
    for (const mutate of [
      (body: any) => { body.contract.version = 2; },
      (body: any) => { body.routes.pop(); },
      (body: any) => { body.routes[1] = structuredClone(body.routes[0]); },
      (body: any) => { body.routes.reverse(); },
      (body: any) => { body.deliveryModes[1] = structuredClone(body.deliveryModes[0]); },
      (body: any) => { body.routes[0].available = 'true'; },
      (body: any) => { body.routes[1].available = true; },
      (body: any) => { body.deliveryModes[3].available = true; },
      (body: any) => { body.registrationEnabled = false; },
      (body: any) => { body.deliveryModes[0].available = false; }
    ]) { const body = structuredClone(valid); mutate(body); expect(() => connectionOffer(body)).toThrow('unavailable'); }
    expect(() => connectionOffer(null)).toThrow('unavailable');
  });
  it('reads public availability without browser credentials and never falls back on fetch failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture('routes-available').response.body)));
    expect((await readConnectionOffer(undefined, fetcher)).localHelper).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/onboarding/routes', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    await expect(readConnectionOffer(undefined, vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))).rejects.toThrow('unavailable');
  });
  it('has a token-free instruction and clean claim return path', () => {
    expect(connectionPrompt('https://www.envoi-agents.com')).toContain('https://www.envoi-agents.com/connect');
    expect(connectionPrompt('https://www.envoi-agents.com')).toContain('local confirmation');
    for (const origin of ['https://www.envoi-agents.com/?code=secret', 'https://user:secret@www.envoi-agents.com', 'http://remote.example']) expect(() => connectionPrompt(origin)).toThrow();
    expect(claimSignInPath('/api/auth/workos/sign-in')).toBe('/api/auth/workos/sign-in?returnTo=%2Fclaim');
    expect(claimSignInPath('/api/auth/workos/sign-in?returnTo=%2F')).toBe('/api/auth/workos/sign-in?returnTo=%2Fclaim');
  });
  it('preserves canonical claim lockout metadata through the shared session transport', async () => {
    const value = fixture('claim-attempts-exhausted');
    setExpectedHuman('human_example');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(value.response.body), { status: value.response.status, headers: value.response.headers }));
    vi.stubGlobal('fetch', fetcher);
    let error: unknown;
    try { await request(value.request.path, { method: 'POST', body: JSON.stringify(value.request.body) }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', reason: 'claim_attempts', retryAfterSeconds: 840, requestId: 'req_example' });
    expect(fetcher).toHaveBeenCalledWith(value.request.path, expect.objectContaining({ credentials: 'same-origin', headers: expect.objectContaining({ 'x-envoi-expected-human': 'human_example' }) }));
  });
});

it('shows ended installations on frozen identities and preserves installation-only reconnect separately', () => {
  const a5 = contractRegistry.contracts.find(value => value.id === 'a5-presence')!;
  const raw = (loadContractFixture(a5, 'owner-revoked.json') as any).response.body;
  const revoked = (Array.isArray(raw) ? raw[0] : raw) as Agent;
  const workspace = { id: 'inbox_example', kind: 'agent', ownerAgentId: revoked.id, ownerHumanId: 'human_example' } as Inbox;
  const render = (agent: Agent, inbox: Inbox) => renderToStaticMarkup(createElement(AgentCard, { agent, workspace: inbox, humanId: 'human_example', canManageInbox: true, emailTransport: null, onRefresh: vi.fn(), notify: vi.fn() }));
  expect(render(revoked, workspace)).toContain('Runtime installations');
  const endedOnly = { ...revoked, status: 'active', onboardingStatus: 'approved', credentialRevoked: true };
  const html = render(endedOnly, workspace);
  expect(html).toContain('Reconnect this identity'); expect(html).not.toContain('No permissions active');
  expect(render(endedOnly, { ...workspace, kind: 'personal', ownerAgentId: null } as any)).not.toContain('Runtime installations');
});
