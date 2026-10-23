import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as validators from '../src/onboarding/remote-auth.validator.mjs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { request, setCsrfCookieName, setExpectedHuman } from '../src/api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BootstrapController, ProviderBootstrapPanel } from '../src/onboarding/ProviderBootstrapPanel';
import { invalidateSessionRequests } from '../src/session-lifecycle';
import { ConsentController } from '../src/onboarding/consent-state';
import { remoteAuthApi } from '../src/onboarding/remote-auth-api';
import type { BootstrapRequest, ConsentApproval } from '../src/onboarding/remote-auth-types';

// Select an exact, clean local source tree, never a URL or an installed service.
// This suite intentionally fails on an incomplete server; it never silently skips.
const selectedServerRoot = process.env.ENVOI_REMOTE_AUTH_SERVER_ROOT;
const serverRoot = resolve(selectedServerRoot ?? '.');
const git = (...args: string[]) => execFileSync('git', ['-C', serverRoot, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const serverSha = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(serverSha)) throw new Error('Select a local server source tree with a full Git SHA');
// Exact-source evidence and CI require a clean tree; ordinary local development may test edits.
if ((selectedServerRoot || process.env.CI === 'true') && git('status', '--porcelain')) throw new Error('Select a clean exact local server source tree');
const harness = await import(/* @vite-ignore */ pathToFileURL(resolve(serverRoot, 'test/a3-harness.js')).href);
const nativeFetch = globalThis.fetch;
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const providerSecret = 'lane-b-local-provider-fixture-secret';
const provider = { clientId: 'client_lane-b-provider', clientName: 'Local provider fixture', connectionRoute: 'provider_connector', redirectUris: ['https://provider.example/callback'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: createHash('sha256').update(providerSecret).digest('hex'), bootstrapCode: true, provider: 'Local fixture provider' };
const clients = [{ clientId: 'client_lane-b-consent', clientName: 'Local consent fixture', connectionRoute: 'remote_mcp_oauth', redirectUris: ['http://127.0.0.1/callback'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Local fixture' }];
const baseEnv = {
  ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true',
  ENVOI_REMOTE_MCP_OAUTH: 'false', ENVOI_PROVIDER_CONNECTORS: 'false',
  ENVOI_OAUTH_CLIENTS: JSON.stringify([...clients, provider]),
  ENVOI_AUTH_PROVIDER: 'local', WORKOS_API_KEY: '', WORKOS_COOKIE_PASSWORD: '',
  ENVOI_EMAIL_TRANSPORT: 'disabled'
};
afterEach(() => {
  vi.unstubAllGlobals(); setExpectedHuman(null); setCsrfCookieName('envoi_csrf'); invalidateSessionRequests();
});
async function launch(enabled: boolean, providers = false) {
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') { probe.close(); reject(new Error('No fixture port')); return; }
      probe.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  return harness.launch({ ...baseEnv, ENVOI_REMOTE_MCP_OAUTH: String(enabled), ENVOI_PROVIDER_CONNECTORS: String(providers), ENVOI_PORT: String(port), ENVOI_PUBLIC_URL: origin });
}
async function authorize(baseUrl: string, state: string) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clients[0].clientId,
    redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: challenge, code_challenge_method: 'S256',
    resource: `${baseUrl}/mcp`, scope: 'envoi.agent envoi.send', state });
  const response = await nativeFetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
  expect(response.status, `authorize on ${serverSha}`).toBe(302);
  return new URL(response.headers.get('location')!).searchParams.get('request')!;
}
/** Browser fetch shim supplies only loopback origin/cookies. Production request() supplies CSRF/account headers. */
function browser(baseUrl: string, who: any, options: { loseFirstApproval?: boolean; loseFirstBootstrap?: boolean; csrf?: boolean } = {}) {
  setExpectedHuman(who.human.id);
  setCsrfCookieName('envoi_csrf');
  vi.stubGlobal('document', { get cookie() { return options.csrf === false ? '' : who.session.headers(baseUrl, 'POST').cookie ?? ''; } });
  const observed: { pathname: string; status: number; headers: Headers; body: any }[] = [];
  let lost = false;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) throw new Error('Only local application paths are permitted');
    const url = new URL(input, baseUrl);
    if (url.origin !== baseUrl) throw new Error('Fixture request escaped loopback');
    const headers = new Headers(who.session.headers(baseUrl, init.method ?? 'GET'));
    headers.delete('x-envoi-csrf'); // Only production request() may supply the CSRF header.
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await nativeFetch(url, { ...init, headers, redirect: 'manual' });
    who.session.capture(response);
    observed.push({ pathname: url.pathname, status: response.status, headers, body: await response.clone().json().catch(() => null) });
    if (!lost && response.ok && (options.loseFirstApproval && url.pathname.endsWith('/approve') || options.loseFirstBootstrap && url.pathname === '/api/oauth/bootstrap-codes')) {
      lost = true; throw new TypeError('Simulated lost local approval response');
    }
    return response;
  });
  return observed;
}
const approval = (who: any, suffix: string): ConsentApproval => ({
  target: { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: 'Local OAuth agent', localPart: `oauth-${suffix}` },
  grantedPermissions: ['receive_agent_messages', 'send_agent_messages'], policyProfile: 'default'
});

it('consumes the exact revision-4 fixture publication with the actual browser validators', () => {
  const read = (relative: string) => JSON.parse(readFileSync(resolve(serverRoot, 'test/contract-fixtures', relative), 'utf8'));
  const registry = read('index.json');
  const contract = registry.contracts.find((item: any) => item.id === 'agent-remote-auth');
  const schemas = read('agent-remote-auth/schemas.json');
  const registration = read('agent-registration/schemas.json');
  const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(registration); ajv.addSchema(schemas);
  const envelope = ajv.getSchema(schemas.$id + '#/definitions/fixture')!;
  let operations = 0; let browserParts = 0;
  expect(contract.fixtures).toHaveLength(70);
  for (const file of contract.fixtures) {
    const fixture = read('agent-remote-auth/' + file);
    expect(envelope(fixture), file).toBe(true);
    for (const step of fixture.steps ?? [fixture]) {
      operations++;
      for (const part of [step.request, step.response]) {
        if (!part.schema) continue;
        const isRegistration = part.schema.startsWith('agent-registration/');
        const name = part.schema.replace('agent-registration/', '');
        const validate = ajv.getSchema((isRegistration ? registration.$id : schemas.$id) + '#/definitions/' + name)!;
        expect(validate(part.body ?? part.bodyText), file + ':' + name).toBe(true);
        if (!isRegistration && name in validators) {
          const browserValidate = validators[name as keyof typeof validators];
          expect(browserValidate(part.body), file + ':' + name).toBe(true); browserParts++;
          expect(browserValidate({ ...part.body, accessToken: 'envoi_agent_access_PLACEHOLDER' })).toBe(false);
        }
      }
    }
  }
  expect(operations).toBe(101); expect(browserParts).toBe(27);
});
it('pairs the actual browser transport/controller with consent, lost-response recovery, restart, withdrawal and denial', { timeout: 60_000 }, async () => {
  let server = await launch(true);
  const controllers: ConsentController[] = [];
  const controller = (handle: string, now = Date.now) => {
    const result = new ConsentController(handle, remoteAuthApi, navigate, now); controllers.push(result); return result;
  };
  const navigate = vi.fn();
  try {
    const who = await harness.owner(server.baseUrl, '8401');
    let observed = browser(server.baseUrl, who);
    const firstHandle = await authorize(server.baseUrl, 'first');
    const first = controller(firstHandle);
    expect(await first.load()).toBe(true);
    expect(first.getSnapshot().view?.client.name).toBe(clients[0].clientName);
    expect(await first.approve(approval(who, 'first'))).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get('code')).toMatch(/^envoi_oauth_code_/);
    expect(JSON.stringify(first.getSnapshot())).not.toMatch(/redirectTo|envoi_oauth_code_/);
    const sent = observed.find(item => item.pathname.endsWith('/approve'))!;
    expect(sent.headers.get('x-envoi-expected-human')).toBe(who.human.id);
    expect(sent.headers.get('x-envoi-csrf')).toBeTruthy();
    expect(sent.headers.has('authorization')).toBe(false);
    expect(await first.load()).toBe(false); // A navigating session cannot submit again.

    const firstOutcome = controller(firstHandle);
    expect(await firstOutcome.load()).toBe(true);
    expect(await firstOutcome.withdraw()).toBe(true);
    expect(firstOutcome.getSnapshot().outcome?.status).toBe('withdrawn');

    const handle = await authorize(server.baseUrl, 'lost');
    observed = browser(server.baseUrl, who, { loseFirstApproval: true });
    let now = Date.now(); const lost = controller(handle, () => now);
    expect(await lost.load()).toBe(true);
    expect(await lost.approve(approval(who, 'lost'))).toBe(false);
    expect(lost.getSnapshot().uncertain, JSON.stringify(lost.getSnapshot().problem)).toBe(true);
    now = lost.getSnapshot().retryAt;
    expect(await lost.retryDecision()).toBe(true);
    expect(lost.getSnapshot().outcome?.status).toBe('pending_exchange');
    expect(observed.filter(item => item.pathname.endsWith('/approve')).map(item => Boolean(item.body.redirectTo))).toEqual([true, false]);
    expect(navigate).toHaveBeenCalledTimes(1);
    lost.dispose();

    const baseUrl = server.baseUrl; const dataDir = server.dataDir;
    await server.stop(true);
    const port = new URL(baseUrl).port;
    server = await harness.launch({ ...baseEnv, ENVOI_REMOTE_MCP_OAUTH: 'true', ENVOI_PORT: port, ENVOI_PUBLIC_URL: baseUrl }, dataDir);
    browser(baseUrl, who);
    const reloaded = controller(handle);
    expect(await reloaded.load()).toBe(true);
    expect(reloaded.getSnapshot().outcome?.status).toBe('pending_exchange');
    expect(await reloaded.withdraw()).toBe(true);
    expect(reloaded.getSnapshot().outcome?.status).toBe('withdrawn');
    expect(navigate).toHaveBeenCalledTimes(1);

    const deniedHandle = await authorize(baseUrl, 'deny'); const denied = controller(deniedHandle);
    expect(await denied.load()).toBe(true); expect(await denied.deny()).toBe(true);
    expect(new URL(navigate.mock.calls[1][0]).searchParams.get('error')).toBe('access_denied');
    const deniedReload = controller(deniedHandle); expect(await deniedReload.load()).toBe(true);
    expect(deniedReload.getSnapshot().outcome?.status).toBe('denied');
    expect(navigate).toHaveBeenCalledTimes(2);
  } finally { for (const item of controllers) item.dispose(); await server.stop(); }
});

it('keeps disabled routes unavailable and refuses cross-account and CSRF writes', { timeout: 60_000 }, async () => {
  let server = await launch(false); let current: ConsentController | undefined;
  try {
    const who = await harness.owner(server.baseUrl, '8402'); browser(server.baseUrl, who);
    current = new ConsentController('v1.disabled', remoteAuthApi, vi.fn());
    expect(await current.load()).toBe(false);
    expect(current.getSnapshot()).toMatchObject({ blocked: true, problem: { code: 'FEATURE_DISABLED' } });
    current.dispose(); await server.stop();

    vi.stubGlobal('fetch', nativeFetch);
    server = await launch(true);
    const first = await harness.owner(server.baseUrl, '8403');
    const second = await harness.owner(server.baseUrl, '8404');
    const handle = await authorize(server.baseUrl, 'account');
    browser(server.baseUrl, first); current = new ConsentController(handle, remoteAuthApi, vi.fn());
    expect(await current.load()).toBe(true);
    browser(server.baseUrl, second); setExpectedHuman(first.human.id);
    expect(await current.approve(approval(first, 'account'))).toBe(false);
    expect(current.getSnapshot()).toMatchObject({ blocked: true, problem: { code: 'ACCOUNT_CHANGED' } });
    current.dispose();

    browser(server.baseUrl, first, { csrf: false });
    current = new ConsentController(handle, remoteAuthApi, vi.fn()); expect(await current.load()).toBe(true);
    expect(await current.approve(approval(first, 'csrf'))).toBe(false);
    expect(current.getSnapshot().outcome).toBeNull();
    expect(current.getSnapshot().phase).not.toBe('redirecting');
  } finally { current?.dispose(); await server.stop(); }
});

// This fixture host keeps credentials outside the browser transport and controller.
// It sends no cookies, and can reach only this test's loopback server.
async function hostForm(baseUrl: string, path: string, fields: Record<string, string>, basic = false) {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl || url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Host fixture escaped loopback');
  const response = await nativeFetch(url, { method: 'POST', redirect: 'manual', headers: {
    'content-type': 'application/x-www-form-urlencoded',
    ...(basic ? { authorization: 'Basic ' + Buffer.from(provider.clientId + ':' + providerSecret).toString('base64') } : {})
  }, body: new URLSearchParams(fields).toString() });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
async function hostRpc(baseUrl: string, token: string, method: string, params: object = {}) {
  const response = await nativeFetch(baseUrl + '/mcp', { method: 'POST', redirect: 'manual', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
function noCredentials(value: unknown, secrets: string[]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text.includes(secret), 'credential leaked from the private host boundary').toBe(false);
  expect(text).not.toMatch(/envoi_oauth_code_|envoi_boot_|envoi_agent_(?:access|refresh)_|"audience"|oauthClientId|codeHash|handleDigest|codeChallenge/);
}

it('pairs an existing paused identity through owner consent, delayed replacement and completed reload', { timeout: 60_000 }, async () => {
  const server = await launch(true); const controllers: ConsentController[] = []; const navigate = vi.fn();
  try {
    const who = await harness.owner(server.baseUrl, '8408');
    await harness.pauseAgent(server.baseUrl, who);
    const base = `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}`;
    const listed = await harness.api(server.baseUrl, base + '/installations', { session: who.session });
    expect(listed.status).toBe(200);
    const current = listed.payload.installations.filter((item: any) => item.status === 'active')
      .sort((a: any, b: any) => b.activatedAt.localeCompare(a.activatedAt))[0];
    expect(current).toBeTruthy();
    const legacyStatus = () => nativeFetch(server.baseUrl + '/api/agent/status', {
      headers: { authorization: 'Bearer ' + who.agentApiToken }, redirect: 'manual'
    });
    browser(server.baseUrl, who);
    const handle = await authorize(server.baseUrl, 'existing-paused');
    const first = new ConsentController(handle, remoteAuthApi, navigate); controllers.push(first);
    expect(await first.load()).toBe(true);
    const selected: ConsentApproval = { target: { kind: 'existing_agent', agentId: who.agent.id, replacesInstallationId: current.id },
      grantedPermissions: ['receive_agent_messages', 'send_agent_messages'], policyProfile: 'default' };
    expect(await first.approve(selected)).toBe(true);
    expect(first.getSnapshot().outcome).toMatchObject({ target: 'existing_agent', agent: { id: who.agent.id, address: who.agent.address } });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect((await legacyStatus()).status).toBe(200); // Consent alone does not end the previous installation.
    const code = new URL(navigate.mock.calls[0][0]).searchParams.get('code')!;
    const exchanged = await hostForm(server.baseUrl, '/oauth/token', { grant_type: 'authorization_code', code,
      client_id: clients[0].clientId, redirect_uri: 'http://127.0.0.1:53682/callback', code_verifier: verifier, resource: server.baseUrl + '/mcp' });
    expect(exchanged.status).toBe(200);
    const ended = await legacyStatus(); expect(ended.status).toBe(401); expect((await ended.json()).code).toBe('CREDENTIAL_REVOKED');
    const paused = await hostRpc(server.baseUrl, exchanged.body.access_token, 'tools/list');
    expect(paused.status).toBe(409); expect(paused.body.code).toBe('AGENT_PAUSED');
    const owners = await request<any[]>(`/api/inboxes/${who.inbox.id}/agents`);
    expect(owners.find(agent => agent.id === who.agent.id)).toMatchObject({ address: who.agent.address, status: 'paused', onboardingStatus: 'approved' });
    const installations = await request<any>(base + '/installations');
    expect(installations.installations.find((item: any) => item.id === current.id)).toMatchObject({ status: 'ended', endedReason: 'replaced' });
    const fresh = installations.installations.filter((item: any) => item.status === 'active');
    expect(fresh).toHaveLength(1); expect(fresh[0]).toMatchObject({ connectionRoute: 'remote_mcp_oauth', deliveryMode: 'on_demand' });
    const completed = new ConsentController(handle, remoteAuthApi, navigate); controllers.push(completed);
    expect(await completed.load()).toBe(true);
    expect(completed.getSnapshot().outcome).toMatchObject({ status: 'completed', target: 'existing_agent', agent: { id: who.agent.id } });
    const retry: any = await remoteAuthApi.approve(handle, selected);
    expect(retry).toMatchObject({ status: 'completed', target: 'existing_agent', agent: { id: who.agent.id } });
    expect(retry.redirectTo).toBeUndefined(); expect(navigate).toHaveBeenCalledTimes(1);
    await request(base + '/resume', { method: 'POST', body: '{}' });
    const info = await hostRpc(server.baseUrl, exchanged.body.access_token, 'tools/call', { name: 'envoi_agent_info', arguments: {} });
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body.result.content[0].text)).toMatchObject({ agentId: who.agent.id, address: who.agent.address });
    noCredentials([first.getSnapshot(), completed.getSnapshot(), retry, owners, installations, info.body], [code, verifier, exchanged.body.access_token, exchanged.body.refresh_token]);
  } finally { for (const controller of controllers) controller.dispose(); await server.stop(); }
});

it('pairs completed consent with private host exchange, MCP scope/pause, refresh recovery and terminal replay', { timeout: 60_000 }, async () => {
  const server = await launch(true);
  const controllers: ConsentController[] = [];
  const navigate = vi.fn();
  const make = (handle: string) => {
    const controller = new ConsentController(handle, remoteAuthApi, navigate); controllers.push(controller); return controller;
  };
  try {
    const who = await harness.owner(server.baseUrl, '8405'); browser(server.baseUrl, who);
    const handle = await authorize(server.baseUrl, 'exchange');
    const first = make(handle); expect(await first.load()).toBe(true);
    const body = approval(who, 'exchange'); body.grantedPermissions = ['receive_agent_messages'];
    expect(await first.approve(body)).toBe(true);
    const code = new URL(navigate.mock.calls[0][0]).searchParams.get('code')!;
    const exchanged = await hostForm(server.baseUrl, '/oauth/token', {
      grant_type: 'authorization_code', client_id: clients[0].clientId, code,
      redirect_uri: 'http://127.0.0.1:53682/callback', code_verifier: verifier, resource: server.baseUrl + '/mcp'
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.scope).toBe('envoi.agent');
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    const tokens = exchanged.body;
    const completed = make(handle); expect(await completed.load()).toBe(true);
    expect(completed.getSnapshot().outcome?.status).toBe('completed');
    expect(navigate).toHaveBeenCalledTimes(1);

    // Neither a read-only REST call nor a wider scope request may consume the grant.
    const rest = await nativeFetch(server.baseUrl + '/api/agent/status', { headers: { authorization: 'Bearer ' + tokens.access_token } });
    expect(rest.status).toBe(401); expect((await rest.json() as any).code).toBe('AUTHENTICATION_REQUIRED');
    const wider = await hostForm(server.baseUrl, '/oauth/token', { grant_type: 'refresh_token', client_id: clients[0].clientId, refresh_token: tokens.refresh_token, scope: 'envoi.agent envoi.send' });
    expect(wider.status).toBe(400); expect(wider.body.error).toBe('invalid_scope');
    const refreshFields = { grant_type: 'refresh_token', client_id: clients[0].clientId, refresh_token: tokens.refresh_token };
    const rotated = await hostForm(server.baseUrl, '/oauth/token', refreshFields);
    expect(rotated.status).toBe(200); expect(rotated.body.scope).toBe('envoi.agent');
    const recovered = await hostForm(server.baseUrl, '/oauth/token', refreshFields);
    expect(recovered.status).toBe(200); expect(recovered.body).toEqual(rotated.body);

    // First successor access use closes that recovery window.
    const infoResponse = await hostRpc(server.baseUrl, rotated.body.access_token, 'tools/call', { name: 'envoi_agent_info', arguments: {} });
    expect(infoResponse.status).toBe(200);
    const info = JSON.parse(infoResponse.body.result.content[0].text);
    expect(info.permissions).toEqual(['receive_agent_messages']);
    const denied = await hostRpc(server.baseUrl, rotated.body.access_token, 'tools/call', { name: 'envoi_start_case', arguments: {} });
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.headers.get('www-authenticate')).toContain('scope="envoi.send"');
    const agentPath = `/api/inboxes/${info.inboxId}/agents/${info.agentId}`;
    const visible = await request<any[]>(`/api/inboxes/${info.inboxId}/agents`);
    expect(visible.find(agent => agent.id === info.agentId).connection.state).toBe('on_demand');
    await request(agentPath + '/pause', { method: 'POST', body: '{}' });
    const paused = await hostRpc(server.baseUrl, rotated.body.access_token, 'tools/list');
    expect(paused.status).toBe(409); expect(paused.body.code).toBe('AGENT_PAUSED');
    const whilePaused = await hostForm(server.baseUrl, '/oauth/token', { grant_type: 'refresh_token', client_id: clients[0].clientId, refresh_token: rotated.body.refresh_token });
    expect(whilePaused.status).toBe(200);
    await request(agentPath + '/resume', { method: 'POST', body: '{}' });
    const replay = await hostForm(server.baseUrl, '/oauth/token', refreshFields);
    expect(replay.status).toBe(400); expect(replay.body.error).toBe('invalid_grant');
    const terminal = await hostRpc(server.baseUrl, whilePaused.body.access_token, 'tools/list');
    expect(terminal.status).toBe(401); expect(terminal.body.code).toBe('CREDENTIAL_REVOKED');
    const installations = await request(agentPath + '/installations');
    noCredentials([first.getSnapshot(), completed.getSnapshot(), visible, installations, info, denied.body],
      [code, verifier, tokens.access_token, tokens.refresh_token, rotated.body.access_token, rotated.body.refresh_token, whilePaused.body.access_token, whilePaused.body.refresh_token]);
  } finally { for (const item of controllers) item.dispose(); await server.stop(); }
});

it('pairs real bootstrap issuance and lost responses with the one-time browser component and private provider exchange', { timeout: 60_000 }, async () => {
  const server = await launch(false, true);
  const controllers: BootstrapController[] = [];
  try {
    const who = await harness.owner(server.baseUrl, '8406'); browser(server.baseUrl, who);
    const requestBody: BootstrapRequest = { ...approval(who, 'bootstrap'), clientId: provider.clientId };
    const controller = new BootstrapController(remoteAuthApi); controllers.push(controller);
    const html = () => renderToStaticMarkup(createElement(ProviderBootstrapPanel, { humanId: who.human.id, request: requestBody, controller }));
    expect(await controller.issue(requestBody)).toBe(true);
    const issued = controller.getSnapshot().issued!;
    expect(html()).toContain(issued.bootstrapCode); expect(html()).toContain(provider.provider);
    expect(html()).not.toContain(providerSecret);
    controller.hide(); expect(controller.getSnapshot().issued).toBeNull(); expect(html()).not.toContain(issued.bootstrapCode);
    expect(await controller.issue(requestBody)).toBe(false);
    const exchanged = await hostForm(server.baseUrl, '/oauth/token', {
      grant_type: 'urn:envoi:params:oauth:grant-type:bootstrap_code', bootstrap_code: issued.bootstrapCode, resource: server.baseUrl + '/mcp'
    }, true);
    expect(exchanged.status).toBe(200);
    const info = await hostRpc(server.baseUrl, exchanged.body.access_token, 'tools/call', { name: 'envoi_agent_info', arguments: {} });
    expect(info.status).toBe(200);
    const revoked = await hostForm(server.baseUrl, '/oauth/revoke', { token: exchanged.body.refresh_token }, true);
    expect(revoked.status).toBe(200);
    const ended = await hostRpc(server.baseUrl, exchanged.body.access_token, 'tools/list');
    expect(ended.status).toBe(401); expect(ended.body.code).toBe('CREDENTIAL_REVOKED');

    vi.stubGlobal('fetch', nativeFetch);
    const other = await harness.owner(server.baseUrl, '8407');
    const observed = browser(server.baseUrl, other, { loseFirstBootstrap: true });
    const lostRequest = { ...approval(other, 'lost-bootstrap'), clientId: provider.clientId };
    const lost = new BootstrapController(remoteAuthApi); controllers.push(lost);
    expect(await lost.issue(lostRequest)).toBe(false); expect(await lost.issue(lostRequest)).toBe(false);
    expect(lost.getSnapshot()).toMatchObject({ attempted: true, issued: null, busy: false });
    expect(observed.filter(item => item.pathname === '/api/oauth/bootstrap-codes')).toHaveLength(1);
    const lostHtml = renderToStaticMarkup(createElement(ProviderBootstrapPanel, { humanId: other.human.id, request: lostRequest, controller: lost }));
    expect(lostHtml).not.toContain('envoi_boot_'); expect(lostHtml).toContain('cannot be displayed again');
    const claims = await request<any>('/api/agent-claims');
    noCredentials([claims, controller.getSnapshot(), lost.getSnapshot(), info.body], [issued.bootstrapCode, providerSecret, exchanged.body.access_token, exchanged.body.refresh_token]);
    const pending = claims.claims.find((claim: any) => claim.status === 'approved');
    expect(pending).toBeTruthy(); await remoteAuthApi.withdraw(pending.registrationId);
  } finally { for (const controller of controllers) controller.dispose(); await server.stop(); }
});
