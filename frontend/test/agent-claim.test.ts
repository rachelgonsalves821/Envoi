import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { ApiError, setCsrfCookieName, setExpectedHuman } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';
import { onboardingApi } from '../src/onboarding/api';
import { ClaimController, claimProblem, newestActiveInstallation, OwnerClaimsController } from '../src/onboarding/claim-state';
import { ClaimPage } from '../src/onboarding/ClaimPage';
import { OwnerClaims } from '../src/onboarding/OwnerClaims';
import { canReconnectAgent, PERMISSION_LABELS, type ClaimApproval, type OnboardingApi } from '../src/onboarding/types';
import type { Agent, Inbox } from '../src/types';

const contract = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
const fixture = (name: string): any => loadContractFixture(contract, `${name}.json`);
const body = (name: string) => fixture(name).response.body;
const nowValue = Date.parse('2026-10-12T12:04:00.000Z');
const clock = () => nowValue;
const client = (): OnboardingApi => ({ lookup: vi.fn().mockResolvedValue(body('claim-lookup')), approve: vi.fn().mockResolvedValue(body('claim-approve-new-agent')),
  reject: vi.fn().mockResolvedValue(body('claim-reject')), claims: vi.fn().mockResolvedValue(body('owner-claims')), withdraw: vi.fn().mockResolvedValue(body('claim-withdraw')),
  installations: vi.fn().mockResolvedValue(body('owner-installations')), revoke: vi.fn().mockResolvedValue(body('owner-installation-revoke')) });
const errorFor = (name: string) => { const response = fixture(name).response; return Object.assign(new ApiError(response.body.message, response.status, response.body.code), response.body); };
const workspace: Inbox = { id: 'inbox_workspace_example', organizationId: 'org_example', name: 'Example workspace', ownerAgentId: null, ownerHumanId: 'human_example', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const markup = (controller: ClaimController) => renderToStaticMarkup(createElement(ClaimPage, { humanId: 'human_example', workspaces: [workspace], agents: [], controller }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setExpectedHuman(null); setCsrfCookieName('envoi_csrf'); });

describe('canonical owner claim API transport', () => {
  it.each([
    ['claim-lookup', () => onboardingApi.lookup(fixture('claim-lookup').request.body.verificationCode)],
    ['claim-approve-new-agent', () => onboardingApi.approve('registration_example', fixture('claim-approve-new-agent').request.body)],
    ['claim-approve-existing-agent', () => onboardingApi.approve('registration_example', fixture('claim-approve-existing-agent').request.body)],
    ['claim-reject', () => onboardingApi.reject('registration_example', fixture('claim-reject').request.body.verificationCode)],
    ['owner-claims', () => onboardingApi.claims()],
    ['claim-withdraw', () => onboardingApi.withdraw('registration_example')]
  ] as const)('%s uses the existing human transport and exact canonical body', async (name, operation) => {
    const entry = fixture(name); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response.body), { status: entry.response.status }));
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('document', { cookie: 'envoi_csrf=PLACEHOLDER_csrf' }); setExpectedHuman('human_example');
    await expect(operation()).resolves.toEqual(entry.response.body);
    const [path, options] = fetcher.mock.calls[0]; expect(path).toBe(entry.request.path);
    expect(options.method ?? 'GET').toBe(entry.request.method); expect(options.credentials).toBe('same-origin');
    const headers = new Headers(options.headers); expect(headers.has('authorization')).toBe(false);
    if (entry.request.method === 'POST') { expect(headers.get('x-envoi-csrf')).toBe('PLACEHOLDER_csrf'); expect(headers.get('x-envoi-expected-human')).toBe('human_example'); }
    expect(options.body === undefined ? undefined : JSON.parse(options.body)).toEqual(entry.request.body);
  });
  it('encodes path segments without allowing a registration id to create another route', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body('claim-reject')))); vi.stubGlobal('fetch', fetcher);
    await onboardingApi.reject('registration/a?b', 'F7KQ-PM4D'); expect(fetcher.mock.calls[0][0]).toBe('/api/agent-registrations/registration%2Fa%3Fb/reject');
  });
  it('rejects late owner data after the session generation changes', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = onboardingApi.claims(); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests(); finish(new Response(JSON.stringify(body('owner-claims')))); await rejected;
  });
});

describe('claim state driven by approved fixtures', () => {
  it('preserves all five canonical permission labels', () => {
    const schema: any = loadContractFixture(contract, 'schemas.json'); expect(PERMISSION_LABELS).toEqual(schema['x-permission-labels']); expect(Object.keys(PERMISSION_LABELS)).toHaveLength(5);
  });
  it('looks up the human-typed code and presents normalized code plus unverified metadata', async () => {
    const api = client(); const controller = new ClaimController(api, clock);
    await controller.lookup('f7kq pm4d'); expect(api.lookup).toHaveBeenCalledWith('f7kq pm4d', expect.any(AbortSignal));
    const html = markup(controller); expect(html).toContain('F7KQ-PM4D'); expect(html).toContain('claims made by the host'); expect(html).toContain('Declared runtime'); expect(html).toContain('hermes 0.9.0');
    expect(html).not.toContain('envoi_reg_'); expect(html).not.toContain('registration_example');
  });
  it('renders the external email permission when requested and grantable', async () => {
    const api = client(); vi.mocked(api.lookup).mockResolvedValue({ ...body('claim-lookup'), requestedPermissions: Object.keys(PERMISSION_LABELS), grantablePermissions: Object.keys(PERMISSION_LABELS) });
    const controller = new ClaimController(api, clock); await controller.lookup('F7KQ-PM4D');
    expect(markup(controller)).toContain('use external email');
  });
  it('approves using the canonical request and renders only server-effective rights', async () => {
    const api = client(); const controller = new ClaimController(api, clock); await controller.lookup('F7KQ-PM4D');
    const approval = fixture('claim-approve-new-agent').request.body; await expect(controller.approve(approval)).resolves.toBe(true);
    expect(api.approve).toHaveBeenCalledWith('registration_example', approval, expect.any(AbortSignal));
    expect(controller.getSnapshot().result).toEqual(body('claim-approve-new-agent'));
    const html = markup(controller); expect(html).toContain('Approval recorded'); expect(html).toContain('Effective permissions: send agent messages, receive agent messages');
    expect(html).not.toContain('act on cases'); expect(html).toContain('Approval does not confirm'); expect(html).toContain('confirm the approving account');
  });
  it('keeps an immutable exact request on uncertain approval, including replay after activation', async () => {
    let now = nowValue; const api = client(); vi.mocked(api.approve).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(body('claim-approve-replayed-after-activation'));
    const controller = new ClaimController(api, () => now); await controller.lookup('F7KQ-PM4D'); const approval: ClaimApproval = structuredClone(fixture('claim-approve-new-agent').request.body);
    await controller.approve(approval); const original = structuredClone(api.approve.mock?.calls?.[0]?.[1] ?? fixture('claim-approve-new-agent').request.body);
    if (approval.target.kind === 'new_agent') approval.target.name = 'Changed form'; approval.grantedPermissions.push('use_email_transport');
    await controller.lookup('ANOTHER'); expect(api.lookup).toHaveBeenCalledTimes(1); controller.reset(); expect(controller.getSnapshot().decision).not.toBeNull();
    await controller.retryDecision(); expect(api.approve).toHaveBeenCalledTimes(1); now += 2000; await expect(controller.retryDecision()).resolves.toBe(true);
    expect(vi.mocked(api.approve).mock.calls[1][1]).toEqual(original); expect(controller.getSnapshot().result).toEqual(body('claim-approve-replayed-after-activation'));
  });
  it('bounds uncertain retries and never creates a changed decision', async () => {
    let now = nowValue; const api = client(); vi.mocked(api.approve).mockRejectedValue(new TypeError('lost response')); const controller = new ClaimController(api, () => now);
    await controller.lookup('F7KQ-PM4D'); await controller.approve(fixture('claim-approve-new-agent').request.body);
    now += 10_000; await controller.retryDecision(); now += 10_000; await controller.retryDecision(); now += 10_000; await controller.retryDecision();
    expect(api.approve).toHaveBeenCalledTimes(3); expect(markup(controller)).toContain('Retry limit reached');
  });
  it('rejects using the matched code and safely replays an uncertain rejection', async () => {
    let now = nowValue; const api = client(); vi.mocked(api.reject).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(body('claim-reject-replayed'));
    const controller = new ClaimController(api, () => now); await controller.lookup('f7kq pm4d'); await controller.reject(); now += 2000; await controller.retryDecision();
    expect(vi.mocked(api.reject).mock.calls.map(call => call.slice(0, 2))).toEqual([['registration_example', 'F7KQ-PM4D'], ['registration_example', 'F7KQ-PM4D']]);
    expect(markup(controller)).toContain('Connection rejected');
  });
  it('requires explicit current installation review before an existing-agent approval', async () => {
    const api = client(); vi.mocked(api.installations).mockResolvedValue(fixture('migration-legacy-family').steps[0].response.body); vi.mocked(api.approve).mockResolvedValue(body('claim-approve-existing-agent'));
    const controller = new ClaimController(api, clock); await controller.lookup('F7KQ-PM4D'); const approval = fixture('claim-approve-existing-agent').request.body;
    await expect(controller.approve(approval)).resolves.toBe(false); await controller.reviewReplacement('inbox_example', 'agent_example'); await expect(controller.approve(approval)).resolves.toBe(false);
    controller.confirmReplacement(true); await expect(controller.approve(approval)).resolves.toBe(true); expect(api.approve).toHaveBeenCalledTimes(1);
  });
  it('reloads installations and requires confirmation again after CLAIM_STALE', async () => {
    const api = client(); vi.mocked(api.installations).mockResolvedValueOnce(fixture('migration-legacy-family').steps[0].response.body).mockResolvedValueOnce(body('owner-installations'));
    vi.mocked(api.approve).mockRejectedValue(errorFor('claim-stale'));
    const controller = new ClaimController(api, clock); await controller.lookup('F7KQ-PM4D'); await controller.reviewReplacement('inbox_example', 'agent_example'); controller.confirmReplacement(true);
    await controller.approve(fixture('claim-approve-existing-agent').request.body);
    expect(api.installations).toHaveBeenCalledTimes(2); expect(controller.getSnapshot().replacementConfirmed).toBe(false);
    expect(newestActiveInstallation(controller.getSnapshot().installations!)?.id).toBe('installation_example'); expect(controller.getSnapshot().decision).toBeNull();
    expect(controller.getSnapshot().problem?.code).toBe('CLAIM_STALE');
  });
  it('locks code entry using canonical RATE_LIMITED metadata and never auto-guesses', async () => {
    let now = nowValue; const api = client(); vi.mocked(api.lookup).mockRejectedValueOnce(errorFor('claim-attempts-exhausted')).mockResolvedValueOnce(body('claim-lookup'));
    const controller = new ClaimController(api, () => now); await controller.lookup('F7KQ-PM4D'); expect(controller.getSnapshot().retryAt).toBe(now + 840_000);
    await controller.lookup('F7KQ-PM4D'); expect(api.lookup).toHaveBeenCalledTimes(1); expect(markup(controller)).toContain('Code entry is locked');
    now += 840_000; await controller.lookup('F7KQ-PM4D'); expect(api.lookup).toHaveBeenCalledTimes(2);
  });
  it.each(['claim-account-changed', 'claim-not-admitted'])('%s discards private details and blocks another action', async name => {
    const api = client(); vi.mocked(api.approve).mockRejectedValue(errorFor(name)); const controller = new ClaimController(api, clock); await controller.lookup('F7KQ-PM4D');
    await controller.approve(fixture('claim-approve-new-agent').request.body); expect(controller.getSnapshot()).toMatchObject({ blocked: true, lookup: null, decision: null, result: null });
    controller.reset(); await controller.lookup('OTHER'); expect(api.lookup).toHaveBeenCalledTimes(1); expect(markup(controller)).not.toContain('Example agent');
  });
  it.each(['claim-code-invalid', 'claim-forbidden', 'claim-invalid', 'claim-address-taken', 'claim-agent-limit', 'claim-pending-activation-limit', 'claim-agent-not-reconnectable', 'claim-already-decided', 'claim-feature-disabled'])('%s has no automatic retry or server-state invention', async name => {
    const problem = claimProblem(errorFor(name), nowValue); expect(problem.code).toBe(fixture(name).response.body.code); expect(problem.retryable).toBe(false); expect(problem.retryAt).toBe(0); expect(problem.message).not.toContain('req_example');
  });
  it('does not approve or reject after the lookup deadline', async () => {
    let now = nowValue; const api = client(); const controller = new ClaimController(api, () => now); await controller.lookup('F7KQ-PM4D'); now = Date.parse(body('claim-lookup').expiresAt);
    await controller.approve(fixture('claim-approve-new-agent').request.body); await controller.reject(); expect(api.approve).not.toHaveBeenCalled(); expect(api.reject).not.toHaveBeenCalled(); expect(markup(controller)).toContain('This code expired');
  });
  it('aborts on disposal and ignores a late response from the old account', async () => {
    const api = client(); let finish!: (lookup: any) => void; vi.mocked(api.lookup).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new ClaimController(api, clock); const pending = controller.lookup('F7KQ-PM4D'); const signal = vi.mocked(api.lookup).mock.calls[0][1]!; controller.dispose(); expect(signal.aborted).toBe(true);
    finish(body('claim-lookup')); await pending; expect(controller.getSnapshot().lookup).toBeNull();
  });
  it('allows an active identity after installation-only revoke, and excludes frozen/pending identities', () => {
    const base = { status: 'active', onboardingStatus: 'approved', credentialRevoked: true } as Agent;
    expect(canReconnectAgent(base)).toBe(true); expect(canReconnectAgent({ ...base, status: 'paused' })).toBe(true);
    expect(canReconnectAgent({ ...base, status: 'revoked' })).toBe(true); expect(canReconnectAgent({ ...base, onboardingStatus: 'revoked' })).toBe(false); expect(canReconnectAgent({ ...base, onboardingStatus: 'pending' })).toBe(false);
  });
});

describe('recent approvals', () => {
  it('shows both own and colleague pending approvals with withdrawal, and activated identity navigation', async () => {
    const api = client(); const controller = new OwnerClaimsController(api, clock); await controller.load();
    const html = renderToStaticMarkup(createElement(OwnerClaims, { humanId: 'human_example', controller, onSelectAgent: vi.fn() }));
    expect(html.match(/>Withdraw approval<\/button>/g)).toHaveLength(2); expect(html).toContain('Approved by a colleague'); expect(html).toContain('>View agent</button>'); expect(html).not.toContain('registration_example');
  });
  it('withdraws a colleague approval and refreshes the authoritative list', async () => {
    const api = client(); const entries = structuredClone(body('owner-claims')); entries.claims[1].status = 'withdrawn';
    vi.mocked(api.claims).mockResolvedValueOnce(body('owner-claims')).mockResolvedValueOnce(entries);
    const controller = new OwnerClaimsController(api, clock); await controller.load(); await controller.withdraw('registration_colleague');
    expect(api.withdraw).toHaveBeenCalledWith('registration_colleague', expect.any(AbortSignal)); expect(controller.getSnapshot().data?.[1].status).toBe('withdrawn');
    await controller.withdraw('registration_colleague'); expect(api.withdraw).toHaveBeenCalledTimes(1);
  });
  it('asks for an authoritative refresh when a cached approval passes its deadline', async () => {
    const controller = new OwnerClaimsController(client(), () => Date.parse('2026-10-12T12:20:00Z')); await controller.load();
    const html = renderToStaticMarkup(createElement(OwnerClaims, { humanId: 'human_example', controller })); expect(html).toContain('Refresh activation status'); expect(html).toContain('whether it activated or expired'); expect(html).not.toContain('>Withdraw approval</button>');
    expect(controller.getSnapshot().data?.[0].status).toBe('approved');
  });
});
