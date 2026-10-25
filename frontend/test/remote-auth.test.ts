import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import schemas from '../../test/contract-fixtures/agent-remote-auth/schemas.json';
import { ApiError, setCsrfCookieName, setExpectedHuman } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';
import { generateRemoteAuthValidators, remoteAuthValidatorFile, remoteAuthSchemaNames } from '../build/remote-auth';
import * as validators from '../src/onboarding/remote-auth.validator.mjs';
import { ConsentController, authorizationHandle, authorizationSignInPath, consentOutcomeText } from '../src/onboarding/consent-state';
import { hasRemotePermissions, remoteGrantAllowed } from '../src/onboarding/remote-auth-grants';
import { remoteAuthApi } from '../src/onboarding/remote-auth-api';
import { AuthorizeAgentPage } from '../src/onboarding/AuthorizeAgentPage';
import { BootstrapController, ProviderBootstrapPanel } from '../src/onboarding/ProviderBootstrapPanel';
import type { ConsentApproval, RemoteAuthApi } from '../src/onboarding/remote-auth-types';

const contract = contractRegistry.contracts.find(item => item.id === 'agent-remote-auth')!;
const fixture = (name: string): any => loadContractFixture(contract, name + '.json');
const body = (name: string) => fixture(name).response.body;
const pendingView = () => fixture('consent-approve-lost-response').steps[2].response.body;
const handle = 'PLACEHOLDER_authorization_request_handle_1';
const initialTime = Date.parse('2026-10-21T12:01:00.000Z');
const approval = (): ConsentApproval => structuredClone(fixture('consent-approve-new-agent').request.body);
const client = (): RemoteAuthApi => ({
  view: vi.fn().mockResolvedValue(body('consent-view')),
  approve: vi.fn().mockResolvedValue(body('consent-approve-new-agent')),
  deny: vi.fn().mockResolvedValue(body('consent-deny')),
  withdraw: vi.fn().mockResolvedValue({ registrationId: 'registration_oauth_example', status: 'withdrawn' }),
  bootstrap: vi.fn().mockResolvedValue(body('bootstrap-code-issued'))
});
const markup = (controller: ConsentController) => renderToStaticMarkup(createElement(AuthorizeAgentPage, { humanId: 'human_example', handle, workspaces: [], agents: [], controller }));
const bootstrapMarkup = (controller: BootstrapController) => renderToStaticMarkup(createElement(ProviderBootstrapPanel, { humanId: 'human_example', request: fixture('bootstrap-code-issued').request.body, controller }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setExpectedHuman(null); setCsrfCookieName('envoi_csrf'); });

describe('canonical remote-auth validators', () => {
  it('consumes the pinned approved fixture generation, including PKCE, scope, replay and rollback boundaries', () => {
    const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(schemas);
    const registration = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
    const registrationSchemas: any = loadContractFixture(registration, 'schemas.json'); ajv.addSchema(registrationSchemas);
    const envelope = ajv.getSchema(schemas.$id + '#/definitions/fixture')!;
    let operations = 0;
    for (const file of contract.fixtures) {
      const entry: any = loadContractFixture(contract, file);
      expect(envelope(entry), file + ':' + JSON.stringify(envelope.errors)).toBe(true);
      for (const step of entry.steps ?? [entry]) {
        operations++;
        for (const part of [step.request, step.response]) {
          if (!part.schema) continue;
          const schemaName = part.schema.replace('agent-registration/', '');
          const schemaId = part.schema.startsWith('agent-registration/') ? registrationSchemas.$id : schemas.$id;
          const validate = ajv.getSchema(schemaId + '#/definitions/' + schemaName)!;
          expect(validate(part.body ?? part.bodyText), file + ':' + part.schema + ':' + JSON.stringify(validate.errors)).toBe(true);
        }
      }
    }
    // Support the integrated rev2 base and the approved rev4 stack; no arbitrary fixture count.
    const checks = schemas['x-token-checks'].authorization_code;
    const policyB = checks[8] === 'code_unused (an otherwise valid replay is denied and revokes the installation)';
    expect(checks).toEqual(policyB
      ? ['route_flag', 'parameters', 'client_authentication', 'code_issued_to_client', 'code_unexpired', 'redirect_uri', 'pkce_s256', 'resource', 'code_unused (an otherwise valid replay is denied and revokes the installation)', 'registration_rechecks']
      : ['route_flag', 'parameters', 'client_authentication', 'code_issued_to_client', 'code_unused (reuse revokes the installation)', 'code_unexpired', 'redirect_uri', 'pkce_s256', 'resource', 'registration_rechecks']);
    expect(contract.fixtures).toHaveLength(policyB ? 70 : 59); expect(operations).toBe(policyB ? 101 : 72);
    expect(body('token-pkce-mismatch').error).toBe('invalid_grant');
    expect(body('oauth-token-refused-on-rest').code).toBe('AUTHENTICATION_REQUIRED');
    expect(body('mcp-paused-oauth-token').code).toBe('AGENT_PAUSED');
    expect(body('mcp-insufficient-scope').code).toBe('INSUFFICIENT_SCOPE');
  });
  it('is reproducible and CSP-safe without require or dynamic compilation', () => {
    const source = readFileSync(remoteAuthValidatorFile, 'utf8').replace(/\r\n/g, '\n');
    expect(source).toBe(generateRemoteAuthValidators());
    expect(source).not.toMatch(/\brequire\(|\beval\(|new Function/);
    const plain = source.replace(/export const /g, 'const ');
    expect(runInNewContext(plain + '; consentView(value);', { value: body('consent-view') }, { contextCodeGeneration: { strings: false, wasm: false } })).toBe(true);
  });
  it('consumes every matching canonical operation, and rejects missing/extra fields', () => {
    const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(schemas);
    let consumed = 0;
    for (const file of contract.fixtures) {
      const entry: any = loadContractFixture(contract, file);
      for (const step of entry.kind === 'sequence' ? entry.steps : [entry]) {
        for (const part of [step.request, step.response]) {
          if (!part || !remoteAuthSchemaNames.includes(part.schema)) continue;
          const validate = validators[part.schema as keyof typeof validators];
          const canonical = ajv.getSchema(schemas.$id + '#/definitions/' + part.schema)!;
          expect(validate(part.body), file + ':' + part.schema).toBe(true); consumed++;
          for (const value of [null, [], {}, { ...part.body, credential: 'envoi_agent_access_SECRET' }]) {
            expect(validate(value)).toBe(canonical(value)); expect(validate(value)).toBe(false);
          }
          for (const required of (schemas.definitions as any)[part.schema].required) {
            const value = structuredClone(part.body); delete value[required]; expect(validate(value)).toBe(false);
          }
        }
      }
    }
    expect(consumed).toBe(27);
  });
});

describe('human-session OAuth transport', () => {
  it.each([
    ['consent-view', () => remoteAuthApi.view(handle)],
    ['consent-approve-new-agent', () => remoteAuthApi.approve(handle, approval())],
    ['consent-deny', () => remoteAuthApi.deny(handle)],
    ['bootstrap-code-issued', () => remoteAuthApi.bootstrap(fixture('bootstrap-code-issued').request.body)]
  ] as const)('%s keeps CSRF/account/session transport and canonical bodies', async (name, operation) => {
    const entry = fixture(name); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response.body), { status: entry.response.status }));
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('document', { cookie: 'envoi_csrf=PLACEHOLDER_csrf' }); setExpectedHuman('human_example');
    await expect(operation()).resolves.toEqual(entry.response.body);
    const [path, options] = fetcher.mock.calls[0]; const headers = new Headers(options.headers);
    expect(path).toBe(entry.request.path); expect(options.credentials).toBe('same-origin'); expect(headers.has('authorization')).toBe(false);
    if (entry.request.method === 'POST') {
      expect(headers.get('x-envoi-csrf')).toBe('PLACEHOLDER_csrf');
      expect(headers.get('x-envoi-expected-human')).toBe('human_example');
      expect(JSON.parse(options.body)).toEqual(entry.request.body ?? {});
    }
  });
  it('uses the existing withdrawal path and encodes opaque handle segments', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetcher);
    await remoteAuthApi.view('a/b?c'); expect(fetcher.mock.calls[0][0]).toBe('/api/oauth/authorization-requests/a%2Fb%3Fc');
    await remoteAuthApi.withdraw('registration_example'); expect(fetcher.mock.calls[1][0]).toBe('/api/agent-claims/registration_example/withdraw');
  });
  it('rejects a response from an ended session', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = remoteAuthApi.view(handle); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests(); finish(new Response(JSON.stringify(body('consent-view')))); await rejected;
  });
});

describe('consent revision 2 owner behavior', () => {
  it('presents client claims, source, redirect, permissions and a target choice without raw handles', async () => {
    const controller = new ConsentController(handle, client(), vi.fn(), () => initialTime); await controller.load();
    const html = markup(controller);
    for (const value of ['Example Assistant', '(claims to be)', 'assistant.example.com', 'Authorization returns to', 'send agent messages', 'Create a new agent', 'Reconnect an existing agent']) expect(html).toContain(value);
    expect(html).not.toContain(handle); expect(html).not.toContain('envoi_oauth_code_');
  });
  it('warns explicitly for loopback and renders provider identity from pre-registration', async () => {
    const api = client(); vi.mocked(api.view).mockResolvedValue(body('consent-view-loopback'));
    const controller = new ConsentController(handle, api, vi.fn(), () => initialTime); await controller.load();
    expect(markup(controller)).toContain('Any program on that computer'); expect(markup(controller)).toContain('connection you just started');
    const provider = { ...body('consent-view'), client: { name: 'Reviewed connector', clientIdHost: null, redirectHost: 'provider.example', loopbackRedirect: false, registration: 'pre_registered', provider: 'Example Provider' }, connectionRoute: 'provider_connector' };
    vi.mocked(api.view).mockResolvedValue(provider); await controller.load();
    expect(markup(controller)).toContain('Example Provider');
  });
  it('redirects exactly once on first consentApproved and retains no code-bearing response', async () => {
    const api = client(); const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime);
    await controller.load(); expect(await controller.approve(approval())).toBe(true);
    await controller.approve(approval()); await controller.retryDecision(); await controller.load();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(body('consent-approve-new-agent').redirectTo); expect(api.approve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/redirectTo|envoi_oauth_code_/); expect(markup(controller)).not.toContain('envoi_oauth_code_');
  });
  it.each(['pending', 'completed', 'expired', 'withdrawn'])('renders %s from identical approval retry without navigation', async suffix => {
    let now = initialTime; const api = client(); const navigate = vi.fn();
    vi.mocked(api.approve).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(body('consent-approve-retry-' + suffix));
    const controller = new ConsentController(handle, api, navigate, () => now); await controller.load();
    const sent = approval(); const captured = structuredClone(sent); await controller.approve(sent); sent.grantedPermissions.length = 0;
    expect(controller.getSnapshot().uncertain).toBe(true); expect(markup(controller)).not.toContain('Create a new agent');
    now = controller.getSnapshot().retryAt; await controller.retryDecision();
    expect(vi.mocked(api.approve).mock.calls.map(call => call[1])).toEqual([captured, captured]);
    expect(navigate).not.toHaveBeenCalled();
    const status = body('consent-approve-retry-' + suffix).status;
    expect(markup(controller)).toContain(consentOutcomeText[status as keyof typeof consentOutcomeText].replaceAll("'", '&#x27;'));
    expect(markup(controller).includes('Withdraw approval')).toBe(suffix === 'pending');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('redirectTo');
  });
  it('recovers through a fresh controller after restart/reload, including after handle expiry', async () => {
    let now = initialTime; const api = client(); const navigate = vi.fn(); const steps = fixture('consent-approve-lost-response').steps;
    vi.mocked(api.approve).mockRejectedValue(new TypeError('lost response'));
    const before = new ConsentController(handle, api, navigate, () => now); await before.load(); await before.approve(approval()); before.dispose();
    const decidedView = pendingView();
    vi.mocked(api.view).mockResolvedValue(decidedView);
    const after = new ConsentController(handle, api, navigate, () => now); await after.load();
    expect(after.getSnapshot().outcome?.status).toBe('pending_exchange'); expect(markup(after)).not.toContain('Approve access');
    now = Date.parse(decidedView.expiresAt) + 1000;
    vi.mocked(api.view).mockResolvedValue({ ...decidedView, decision: steps.at(-1).response.body }); await after.load();
    expect(after.getSnapshot().outcome?.status).toBe('expired'); expect(navigate).not.toHaveBeenCalled();
  });
  it('Withdraw refreshes the authoritative registration outcome and handles an exchange race', async () => {
    const api = client(); const navigate = vi.fn(); vi.mocked(api.view).mockResolvedValue(pendingView());
    const controller = new ConsentController(handle, api, navigate, () => initialTime); await controller.load();
    vi.mocked(api.view).mockResolvedValue({ ...body('consent-view-decided'), decision: body('consent-approve-retry-withdrawn') });
    expect(await controller.withdraw()).toBe(true); expect(api.withdraw).toHaveBeenCalledWith('registration_oauth_example', expect.any(AbortSignal));
    expect(controller.getSnapshot().outcome?.status).toBe('withdrawn'); expect(navigate).not.toHaveBeenCalled();
    vi.mocked(api.view).mockResolvedValue(pendingView()); await controller.load();
    vi.mocked(api.withdraw).mockRejectedValueOnce(new ApiError('not found', 404, 'CLAIM_NOT_FOUND')); await controller.withdraw();
    vi.mocked(api.view).mockResolvedValue({ ...body('consent-view-decided'), decision: body('consent-approve-retry-completed') }); await controller.load();
    expect(controller.getSnapshot().outcome?.status).toBe('completed');
  });
  it('declines through the code-free redirect and reloads a denial without navigating', async () => {
    const api = client(); const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime);
    await controller.load(); await controller.deny(); expect(navigate).toHaveBeenCalledExactlyOnceWith(body('consent-deny').redirectTo);
    const reloaded = new ConsentController(handle, api, navigate, () => initialTime);
    vi.mocked(api.view).mockResolvedValue({ ...body('consent-view'), decision: { status: 'denied' } }); await reloaded.load();
    expect(markup(reloaded)).toContain('Connection declined'); expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('expires an unconsumed request and never navigates a late first response', async () => {
    let now = initialTime; const api = client(); const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => now);
    await controller.load(); now = Date.parse(body('consent-view').expiresAt); expect(await controller.approve(approval())).toBe(false); expect(api.approve).not.toHaveBeenCalled();
    now = initialTime;
    vi.mocked(api.approve).mockImplementationOnce(async () => { now = Date.parse(body('consent-approve-new-agent').codeExpiresAt); return body('consent-approve-new-agent'); });
    await controller.approve(approval()); expect(controller.getSnapshot().outcome?.status).toBe('expired'); expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['ACCOUNT_CHANGED', 'AUTHENTICATION_REQUIRED', 'FEATURE_DISABLED', 'AUTHORIZATION_REQUEST_INVALID'])('clears sensitive view and blocks on %s', async code => {
    const api = client(); const controller = new ConsentController(handle, api, vi.fn(), () => initialTime);
    await controller.load(); vi.mocked(api.approve).mockRejectedValue(new ApiError('envoi_oauth_code_SHOULD_NOT_RENDER', 409, code)); await controller.approve(approval());
    expect(controller.getSnapshot()).toMatchObject({ blocked: true, view: null, outcome: null }); expect(markup(controller)).not.toContain('SHOULD_NOT_RENDER');
  });
  it('allows editing after a known validation refusal, but cannot widen permissions', async () => {
    const api = client(); const controller = new ConsentController(handle, api, vi.fn(), () => initialTime); await controller.load();
    const widened = approval(); widened.grantedPermissions.push('use_email_transport'); expect(await controller.approve(widened)).toBe(false);
    vi.mocked(api.approve).mockRejectedValueOnce(new ApiError('taken', 409, 'ADDRESS_TAKEN')); await controller.approve(approval());
    expect(controller.getSnapshot().uncertain).toBe(false); expect(markup(controller)).toContain('Create a new agent');
  });
  it('bounds uncertain retries and refuses a changed body after a lost response', async () => {
    let now = initialTime; const api = client(); vi.mocked(api.approve).mockRejectedValue(new TypeError('lost')); const controller = new ConsentController(handle, api, vi.fn(), () => now); await controller.load();
    await controller.approve(approval()); const changed = approval(); changed.target = { ...changed.target, name: 'Changed' } as any; await controller.approve(changed);
    for (let index = 0; index < 4; index++) { now = controller.getSnapshot().retryAt; await controller.retryDecision(); }
    expect(api.approve).toHaveBeenCalledTimes(3);
  });
  it('rejects malformed responses, mismatched redirect hosts and late unmounted responses', async () => {
    for (const response of [
      { ...body('consent-approve-new-agent'), redirectTo: 'javascript:alert(1)' },
      { ...body('consent-approve-new-agent'), redirectTo: 'https://attacker.example/callback?code=envoi_oauth_code_X' },
      { ...body('consent-approve-retry-completed'), redirectTo: body('consent-approve-new-agent').redirectTo }
    ]) {
      const api = client(); vi.mocked(api.approve).mockResolvedValue(response); const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime);
      await controller.load(); await controller.approve(approval()); expect(navigate).not.toHaveBeenCalled(); expect(controller.getSnapshot().blocked).toBe(true);
    }
    const api = client(); let finish!: (value: unknown) => void; vi.mocked(api.approve).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime); await controller.load();
    const pending = controller.approve(approval()); controller.dispose(); finish(body('consent-approve-new-agent')); await pending; expect(navigate).not.toHaveBeenCalled();
  });
  it('does not duplicate an in-flight approval or follow a stale read', async () => {
    const api = client(); let finish!: (value: unknown) => void; vi.mocked(api.approve).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new ConsentController(handle, api, vi.fn(), () => initialTime); await controller.load();
    const pending = controller.approve(approval()); await controller.approve(approval()); await controller.load(); expect(api.approve).toHaveBeenCalledTimes(1); expect(api.view).toHaveBeenCalledTimes(1);
    finish(body('consent-approve-retry-pending')); await pending;
  });
  it('keeps only one validated opaque handle in the sign-in return path', () => {
    expect(authorizationHandle('?request=a&request=b')).toBeNull(); expect(authorizationHandle('?request=')).toBeNull(); expect(authorizationHandle('?request=' + 'x'.repeat(2049))).toBeNull();
    expect(authorizationHandle('?request=abc%2Fdef')).toBe('abc/def');
    const url = new URL(authorizationSignInPath('/api/auth/workos/sign-in', '?request=abc%2Fdef&code=DO_NOT_FORWARD'), 'https://www.envoi-agents.com');
    expect(url.searchParams.get('returnTo')).toBe('/authorize-agent?request=abc%2Fdef'); expect(url.href).not.toContain('DO_NOT_FORWARD');
  });
});

describe('remote OAuth grant boundaries', () => {
  it('pins the semantic permission allowlist to the approved x-scopes table', () => {
    const required = schemas['x-scopes'].find(row => row.required)!.permission;
    for (const row of schemas['x-scopes']) {
      expect(hasRemotePermissions([row.permission as any])).toBe(true);
      expect(remoteGrantAllowed([required as any, row.permission as any])).toBe(true);
    }
    expect(hasRemotePermissions(['use_email_transport'])).toBe(false);
    expect(remoteGrantAllowed(['send_agent_messages'])).toBe(false);
  });
  it('preserves the mandatory receive grant when a valid bootstrap request omits that selection', async () => {
    const api = client(); const request = structuredClone(fixture('bootstrap-code-issued').request.body);
    request.grantedPermissions = ['send_agent_messages'];
    const controller = new BootstrapController(api, () => initialTime);
    expect(await controller.issue(request)).toBe(true);
    expect(controller.getSnapshot().issued?.effectivePermissions).toContain('receive_agent_messages');
  });
  it('refuses a bootstrap response that drops the mandatory receive grant', async () => {
    const api = client(); const response = structuredClone(body('bootstrap-code-issued'));
    response.effectivePermissions = ['send_agent_messages']; vi.mocked(api.bootstrap).mockResolvedValue(response);
    const controller = new BootstrapController(api, () => initialTime);
    expect(await controller.issue(fixture('bootstrap-code-issued').request.body)).toBe(false);
    expect(controller.getSnapshot().issued).toBeNull();
  });

  it.each(['requestedPermissions', 'grantablePermissions'] as const)('rejects an out-of-scope permission in a consent %s list', async field => {
    const api = client(); const view = structuredClone(body('consent-view'));
    view[field].push('use_email_transport');
    expect(validators.consentView(view)).toBe(true); // Shape validation alone allows the shared registration enum.
    vi.mocked(api.view).mockResolvedValue(view);
    const controller = new ConsentController(handle, api, vi.fn(), () => initialTime);
    expect(await controller.load()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ blocked: true, view: null, outcome: null, problem: { code: 'INVALID_OAUTH_RESPONSE' } });
  });
  it.each(['consent-approve-new-agent', 'consent-approve-retry-completed'])('refuses a widened %s grant before navigation or retained state', async responseName => {
    const api = client(); const navigate = vi.fn(); const response = structuredClone(body(responseName));
    response.effectivePermissions.push('create_assets');
    vi.mocked(api.approve).mockResolvedValue(response);
    const controller = new ConsentController(handle, api, navigate, () => initialTime);
    await controller.load(); expect(await controller.approve(approval())).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ blocked: true, outcome: null, problem: { code: 'INVALID_OAUTH_RESPONSE' } });
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/redirectTo|envoi_oauth_code_/);
  });
  it('rejects an out-of-scope stored decision on reload and withdrawal readback', async () => {
    const api = client(); const view = structuredClone(pendingView());
    view.decision.effectivePermissions.push('use_email_transport');
    vi.mocked(api.view).mockResolvedValue(view);
    const controller = new ConsentController(handle, api, vi.fn(), () => initialTime);
    expect(await controller.load()).toBe(false); expect(controller.getSnapshot().outcome).toBeNull();
    const withdrawing = new ConsentController(handle, api, vi.fn(), () => initialTime);
    vi.mocked(api.view).mockResolvedValue(pendingView()); await withdrawing.load();
    vi.mocked(api.view).mockResolvedValue(view);
    expect(await withdrawing.withdraw()).toBe(false); expect(withdrawing.getSnapshot().outcome).toBeNull();
  });
  it('refuses a bootstrap permission without an OAuth scope before any issuance request', async () => {
    const api = client(); const controller = new BootstrapController(api, () => initialTime);
    const request = structuredClone(fixture('bootstrap-code-issued').request.body);
    request.grantedPermissions.push('use_email_transport');
    expect(validators.bootstrapCodeRequest(request)).toBe(true);
    expect(await controller.issue(request)).toBe(false); expect(api.bootstrap).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ attempted: false, issued: null });
  });
  it.each(['create_assets', 'use_email_transport'])('never displays an unexpected bootstrap %s grant, even when the caller edits its body while pending', async permission => {
    const api = client(); let finish!: (value: unknown) => void;
    vi.mocked(api.bootstrap).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new BootstrapController(api, () => initialTime);
    const request = structuredClone(fixture('bootstrap-code-issued').request.body);
    const pending = controller.issue(request);
    request.grantedPermissions.push(permission);
    const response = structuredClone(body('bootstrap-code-issued')); response.effectivePermissions.push(permission);
    finish(response); expect(await pending).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ attempted: true, issued: null, problem: { code: 'INVALID_OAUTH_RESPONSE' } });
    expect(bootstrapMarkup(controller)).not.toContain(response.bootstrapCode);
    await controller.issue(request); expect(api.bootstrap).toHaveBeenCalledTimes(1);
  });
  it('accepts a legitimate narrower bootstrap grant and retains the mandatory receive permission', async () => {
    const api = client(); const response = structuredClone(body('bootstrap-code-issued'));
    response.effectivePermissions = ['receive_agent_messages']; vi.mocked(api.bootstrap).mockResolvedValue(response);
    const controller = new BootstrapController(api, () => initialTime);
    expect(await controller.issue(fixture('bootstrap-code-issued').request.body)).toBe(true);
    expect(controller.getSnapshot().issued?.effectivePermissions).toEqual(['receive_agent_messages']);
  });
});

describe('approval target binding', () => {
  const existingView = () => ({ ...structuredClone(body('consent-view')),
    requestedPermissions: [...fixture('consent-approve-existing-agent').request.body.grantedPermissions],
    grantablePermissions: [...fixture('consent-approve-existing-agent').request.body.grantedPermissions] });

  it.each(['consent-approve-new-agent', 'consent-approve-retry-completed'])('rejects a different target kind in %s without navigation or retention', async responseName => {
    const api = client(); const response = structuredClone(body(responseName));
    response.target = 'existing_agent'; response.agent.id = 'agent_other';
    vi.mocked(api.approve).mockResolvedValue(response);
    const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime);
    await controller.load(); expect(await controller.approve(approval())).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ blocked: true, outcome: null, problem: { code: 'INVALID_OAUTH_RESPONSE' } });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('envoi_oauth_code_');
  });
  it.each(['wrong', 'missing'])('refuses a %s existing-agent ID on first approval and a code-free retry', async mismatch => {
    for (const decided of [false, true]) {
      const entry = fixture('consent-approve-existing-agent'); const response = structuredClone(entry.response.body);
      if (decided) { delete response.redirectTo; response.status = 'completed'; }
      if (mismatch === 'missing') delete response.agent.id; else response.agent.id = 'agent_other';
      const api = client(); vi.mocked(api.view).mockResolvedValue(existingView()); vi.mocked(api.approve).mockResolvedValue(response);
      const navigate = vi.fn(); const controller = new ConsentController(handle, api, navigate, () => initialTime);
      await controller.load(); expect(await controller.approve(entry.request.body)).toBe(false);
      expect(api.approve).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled(); expect(controller.getSnapshot().outcome).toBeNull();
    }
  });
  it('accepts the selected existing identity and never navigates its code-free retry', async () => {
    const entry = fixture('consent-approve-existing-agent'); const api = client(); const navigate = vi.fn();
    vi.mocked(api.view).mockResolvedValue(existingView());
    vi.mocked(api.approve).mockResolvedValue(entry.response.body);
    const controller = new ConsentController(handle, api, navigate, () => initialTime); await controller.load();
    expect(await controller.approve(entry.request.body)).toBe(true); expect(navigate).toHaveBeenCalledExactlyOnceWith(entry.response.body.redirectTo);
    const decided = structuredClone(entry.response.body); delete decided.redirectTo; decided.status = 'completed';
    vi.mocked(api.approve).mockResolvedValue(decided);
    const retry = new ConsentController(handle, api, navigate, () => initialTime); await retry.load();
    expect(await retry.approve(entry.request.body)).toBe(true); expect(retry.getSnapshot().outcome?.status).toBe('completed');
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('rejects inconsistent agent-ID shape in a stored decision and withdrawal readback', async () => {
    for (const target of ['new_agent', 'existing_agent']) {
      const api = client(); const view = structuredClone(pendingView()); view.decision.target = target;
      if (target === 'new_agent') view.decision.agent.id = 'agent_unexpected'; else delete view.decision.agent.id;
      vi.mocked(api.view).mockResolvedValue(view);
      const controller = new ConsentController(handle, api, vi.fn(), () => initialTime);
      expect(await controller.load()).toBe(false); expect(controller.getSnapshot().outcome).toBeNull();
      const withdrawing = new ConsentController(handle, api, vi.fn(), () => initialTime);
      vi.mocked(api.view).mockResolvedValue(pendingView()); await withdrawing.load();
      vi.mocked(api.view).mockResolvedValue(view);
      expect(await withdrawing.withdraw()).toBe(false); expect(withdrawing.getSnapshot().outcome).toBeNull();
    }
  });
  it('checks bootstrap against the captured target even if its caller edits the request while pending', async () => {
    const api = client(); let finish!: (value: unknown) => void;
    vi.mocked(api.bootstrap).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new BootstrapController(api, () => initialTime);
    const request = structuredClone(fixture('bootstrap-code-issued').request.body);
    const pending = controller.issue(request);
    request.target = { kind: 'existing_agent', agentId: 'agent_other', replacesInstallationId: null };
    const response = structuredClone(body('bootstrap-code-issued')); response.target = 'existing_agent'; response.agent.id = 'agent_other';
    finish(response); expect(await pending).toBe(false); expect(controller.getSnapshot().issued).toBeNull();
    expect(bootstrapMarkup(controller)).not.toContain(response.bootstrapCode);
    await controller.issue(request); expect(api.bootstrap).toHaveBeenCalledTimes(1);
  });
  it('accepts a matching existing-agent bootstrap response and refuses a different agent', async () => {
    const entry = fixture('consent-approve-existing-agent');
    const request = { ...structuredClone(fixture('bootstrap-code-issued').request.body), target: entry.request.body.target };
    for (const matches of [true, false]) {
      const api = client(); const response = structuredClone(body('bootstrap-code-issued'));
      response.target = 'existing_agent'; response.agent.id = matches ? entry.request.body.target.agentId : 'agent_other';
      vi.mocked(api.bootstrap).mockResolvedValue(response);
      const controller = new BootstrapController(api, () => initialTime);
      expect(await controller.issue(request)).toBe(matches);
      expect(Boolean(controller.getSnapshot().issued)).toBe(matches);
    }
  });
});

describe('one-time provider bootstrap component', () => {
  it('starts a new display session when the owner, target or granted permissions change', () => {
    const request = fixture('bootstrap-code-issued').request.body;
    const panel = (body = request, humanId = 'human_example') => ProviderBootstrapPanel({ humanId, request: body });
    const original = panel();
    expect(panel(structuredClone(request)).key).toBe(original.key);
    expect(panel(request, 'human_other').key).not.toBe(original.key);
    expect(panel({ ...request, target: { ...request.target, name: 'Different agent' } }).key).not.toBe(original.key);
    expect(panel({ ...request, grantedPermissions: ['receive_agent_messages'] }).key).not.toBe(original.key);
    expect(panel({ ...request, clientId: 'client_other' }).key).not.toBe(original.key);
  });
  it('discards a late response from a retired bootstrap session', async () => {
    const api = client(); let finish!: (value: unknown) => void;
    vi.mocked(api.bootstrap).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new BootstrapController(api, () => initialTime);
    const pending = controller.issue(fixture('bootstrap-code-issued').request.body);
    controller.dispose(); finish(body('bootstrap-code-issued'));
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().issued).toBeNull();
    expect(vi.mocked(api.bootstrap).mock.calls[0][1]?.aborted).toBe(true);
  });
  it('issues once, identifies the provider, and erases the code on hide', async () => {
    const api = client(); const controller = new BootstrapController(api, () => initialTime); const request = fixture('bootstrap-code-issued').request.body;
    await controller.issue(request); await controller.issue(request);
    expect(api.bootstrap).toHaveBeenCalledTimes(1); expect(bootstrapMarkup(controller)).toContain(body('bootstrap-code-issued').bootstrapCode);
    expect(bootstrapMarkup(controller)).toContain('Example Provider'); expect(bootstrapMarkup(controller)).toContain('never into a chat');
    controller.hide(); expect(bootstrapMarkup(controller)).not.toContain('envoi_boot_'); expect(controller.getSnapshot().issued).toBeNull();
  });
  it('does not retry a lost response or reissue during a request, and clears expired/disposed codes', async () => {
    let now = initialTime; const api = client(); vi.mocked(api.bootstrap).mockRejectedValueOnce(new TypeError('envoi_boot_SHOULD_NOT_RENDER'));
    const failed = new BootstrapController(api, () => now); await failed.issue(fixture('bootstrap-code-issued').request.body); await failed.issue(fixture('bootstrap-code-issued').request.body);
    expect(api.bootstrap).toHaveBeenCalledTimes(1); expect(bootstrapMarkup(failed)).not.toContain('SHOULD_NOT_RENDER');
    const controller = new BootstrapController(api, () => now); await controller.issue(fixture('bootstrap-code-issued').request.body);
    now = Date.parse(body('bootstrap-code-issued').expiresAt); expect(bootstrapMarkup(controller)).not.toContain('envoi_boot_'); controller.expire(); expect(controller.getSnapshot().issued).toBeNull();
    controller.dispose(); expect(controller.getSnapshot().issued).toBeNull();
  });
});
