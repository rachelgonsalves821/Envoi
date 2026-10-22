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
import { setCsrfCookieName, setExpectedHuman } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';
import { ConsentController } from '../src/onboarding/consent-state';
import { remoteAuthApi } from '../src/onboarding/remote-auth-api';
import type { ConsentApproval } from '../src/onboarding/remote-auth-types';

// Select an exact, clean local source tree, never a URL or an installed service.
// This suite intentionally fails on an incomplete server; it never silently skips.
const serverRoot = resolve(process.env.ENVOI_REMOTE_AUTH_SERVER_ROOT ?? '.');
const git = (...args: string[]) => execFileSync('git', ['-C', serverRoot, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const serverSha = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(serverSha) || git('status', '--porcelain')) throw new Error('Select a clean exact local server source tree');
const harness = await import(/* @vite-ignore */ pathToFileURL(resolve(serverRoot, 'test/a3-harness.js')).href);
const nativeFetch = globalThis.fetch;
const challenge = createHash('sha256').update('a'.repeat(43)).digest('base64url');
const clients = [{ clientId: 'client_lane-b-consent', clientName: 'Local consent fixture', connectionRoute: 'remote_mcp_oauth', redirectUris: ['http://127.0.0.1/callback'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Local fixture' }];
const baseEnv = {
  ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true',
  ENVOI_REMOTE_MCP_OAUTH: 'false', ENVOI_PROVIDER_CONNECTORS: 'false',
  ENVOI_OAUTH_CLIENTS: JSON.stringify(clients),
  ENVOI_AUTH_PROVIDER: 'local', WORKOS_API_KEY: '', WORKOS_COOKIE_PASSWORD: '',
  ENVOI_EMAIL_TRANSPORT: 'disabled'
};
afterEach(() => {
  vi.unstubAllGlobals(); setExpectedHuman(null); setCsrfCookieName('envoi_csrf'); invalidateSessionRequests();
});
async function launch(enabled: boolean) {
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') { probe.close(); reject(new Error('No fixture port')); return; }
      probe.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  return harness.launch({ ...baseEnv, ENVOI_REMOTE_MCP_OAUTH: String(enabled), ENVOI_PORT: String(port), ENVOI_PUBLIC_URL: origin });
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
function browser(baseUrl: string, who: any, options: { loseFirstApproval?: boolean; csrf?: boolean } = {}) {
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
    if (options.loseFirstApproval && !lost && url.pathname.endsWith('/approve') && response.ok) {
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
it('pairs the actual browser transport/controller with consent, lost-response recovery, restart, withdrawal and denial', async () => {
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

it('keeps disabled routes unavailable and refuses cross-account and CSRF writes', async () => {
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
