import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { discoverOpenClaw, preflightOpenClaw, OpenClawSetupError, type DiscoverOpenClawOptions, type OpenClawConfiguration } from './quick-connect-config';

const token = 'private-gateway-secret';
const base = { gateway: { auth: { token }, http: { endpoints: { chatCompletions: { enabled: true } } } } };
function discover(config: unknown = base, options: DiscoverOpenClawOptions = {}) {
  return discoverOpenClaw({ env: {}, homeDir: '/test-home', readFile: async () => typeof config === 'string' ? config : JSON.stringify(config), ...options });
}
function completed(content = 'Connected') {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
}
const connection: OpenClawConfiguration = { gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: token, agentId: 'main', configPath: '/test/openclaw.json', chatCompletionsEnabled: true };

describe('OpenClaw quick connect discovery', () => {
  it('detects default local origin, main agent, credential and endpoint', async () => {
    const result = await discover();
    expect(result).toEqual({ ...connection, configPath: resolve('/test-home', '.openclaw', 'openclaw.json') });
  });

  it('reads useful JSON5 syntax as data while preserving URL and comment-like string contents', async () => {
    const result = await discover(`// local Gateway\n{ gateway: { port: 19999, auth: { token: 'secret//not-a-comment', }, /* endpoint */ http: { endpoints: {chatCompletions: {enabled: true,}},},}, agents: {list: [{id: 'potato',},],}, }`);
    expect(result.gatewayToken).toBe('secret//not-a-comment');
    expect(result.gatewayUrl).toBe('http://127.0.0.1:19999');
    expect(result.agentId).toBe('potato');
    expect(result.chatCompletionsEnabled).toBe(true);
  });

  it('resolves env substitution and env SecretRef locally', async () => {
    const env = { PRIVATE_GATEWAY_TOKEN: token };
    await expect(discover({ ...base, gateway: { ...base.gateway, auth: { token: '${PRIVATE_GATEWAY_TOKEN}' } } }, { env })).resolves.toMatchObject({ gatewayToken: token });
    await expect(discover({ gateway: { auth: { token: { source: 'env', provider: 'default', id: 'PRIVATE_GATEWAY_TOKEN' } } } }, { env })).resolves.toMatchObject({ gatewayToken: token });
  });

  it('requires a deliberate choice when multiple legacy or canonical agents exist', async () => {
    for (const agents of [{ list: [{ id: 'main', default: true }, { id: 'potato' }] }, { entries: { main: {}, potato: {} } }]) {
      await expect(discover({ ...base, agents })).rejects.toThrow('Available agents: main, potato');
      await expect(discover({ ...base, agents }, { agentId: 'potato' })).resolves.toMatchObject({ agentId: 'potato' });
      await expect(discover({ ...base, agents }, { agentId: 'absent' })).rejects.toThrow('not configured');
    }
  });

  it('gives canonical agents.entries precedence over legacy roster', async () => {
    await expect(discover({ ...base, agents: { entries: { potato: {} }, list: [{ id: 'old' }] } })).resolves.toMatchObject({ agentId: 'potato' });
  });

  it('uses explicit settings and config/state/profile path precedence', async () => {
    const reader = vi.fn(async () => JSON.stringify(base));
    const env = { OPENCLAW_PROFILE: 'work', OPENCLAW_GATEWAY_PORT: '18888', OPENCLAW_AGENT_ID: 'potato', OPENCLAW_GATEWAY_TOKEN: 'override-secret' };
    await discover(base, { env, readFile: reader });
    expect(reader).toHaveBeenLastCalledWith(resolve('/test-home', '.openclaw-work', 'openclaw.json'));
    await discover(base, { env: { ...env, OPENCLAW_STATE_DIR: '~/gateway-state' }, readFile: reader });
    expect(reader).toHaveBeenLastCalledWith(resolve('/test-home', 'gateway-state', 'openclaw.json'));
    const result = await discover(base, { env: { ...env, OPENCLAW_CONFIG_PATH: '~/selected.json' }, readFile: reader, gatewayUrl: 'https://private.example', gatewayToken: token, agentId: 'main' });
    expect(reader).toHaveBeenLastCalledWith(resolve('/test-home', 'selected.json'));
    expect(result).toMatchObject({ gatewayUrl: 'https://private.example', gatewayToken: token, agentId: 'main', chatCompletionsEnabled: undefined });
  });

  it('uses explicit settings when no default config exists but rejects a missing explicitly selected config', async () => {
    const readFile = async () => { throw Object.assign(new Error('untrusted filesystem message'), { code: 'ENOENT' }); };
    await expect(discover(null, { readFile, env: { OPENCLAW_GATEWAY_TOKEN: token } })).resolves.toMatchObject({ agentId: 'main', chatCompletionsEnabled: undefined });
    await expect(discover(null, { readFile, configPath: '~/missing.json', env: { OPENCLAW_GATEWAY_TOKEN: token } })).rejects.toThrow('not found');
  });

  it('resumes a missing explicitly selected config only with all explicit connection settings', async () => {
    const readFile = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    const settings = { readFile, configPath: '~/missing.json', allowMissingConfig: true };
    await expect(discover(null, { ...settings, gatewayUrl: connection.gatewayUrl, gatewayToken: token, agentId: 'main' })).resolves.toMatchObject({ agentId: 'main', chatCompletionsEnabled: undefined });
    for (const overrides of [{ gatewayToken: token }, { gatewayUrl: connection.gatewayUrl, gatewayToken: token }, { gatewayUrl: connection.gatewayUrl, agentId: 'main' }]) {
      await expect(discover(null, { ...settings, ...overrides })).rejects.toThrow('requires explicit Gateway URL');
    }
  });

  it('uses saved fallback settings only when config is missing and resume is explicitly allowed', async () => {
    const readFile = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    const fallbackConfiguration = { ...connection, agentId: 'potato', gatewayToken: 'saved-gateway-secret' };
    const settings = { readFile, configPath: '~/missing.json', fallbackConfiguration };
    await expect(discover(null, settings)).rejects.toThrow('not found');
    await expect(discover(null, { ...settings, allowMissingConfig: true })).resolves.toMatchObject({ gatewayUrl: connection.gatewayUrl, gatewayToken: 'saved-gateway-secret', agentId: 'potato', chatCompletionsEnabled: undefined });
    await expect(discover(null, { ...settings, allowMissingConfig: true, env: { OPENCLAW_GATEWAY_TOKEN: 'current-secret' } })).resolves.toMatchObject({ gatewayToken: 'current-secret', agentId: 'potato' });
    await expect(discover(null, { ...settings, allowMissingConfig: true, gatewayUrl: 'https://different.example' })).rejects.toThrow('requires its own explicit local Gateway credential');
    await expect(discover(null, { ...settings, allowMissingConfig: true, gatewayUrl: 'https://different.example', gatewayToken: 'different-secret' })).resolves.toMatchObject({ gatewayUrl: 'https://different.example', gatewayToken: 'different-secret' });
  });

  it('reads rotated local settings instead of saved snapshot when the config exists', async () => {
    const fallbackConfiguration = { ...connection, gatewayToken: 'old-secret', agentId: 'old-agent' };
    const config = { gateway: { ...base.gateway, port: 19999, auth: { token: 'rotated-secret' } }, agents: { entries: { potato: {} } } };
    await expect(discover(config, { allowMissingConfig: true, fallbackConfiguration, agentId: 'potato' })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:19999', gatewayToken: 'rotated-secret', agentId: 'potato', chatCompletionsEnabled: true });
    await expect(discover(config, { allowMissingConfig: true, fallbackConfiguration, env: { OPENCLAW_GATEWAY_TOKEN: 'env-secret' }, agentId: 'potato' })).resolves.toMatchObject({ gatewayToken: 'env-secret' });
    await expect(discover(config, { allowMissingConfig: true, fallbackConfiguration, agentId: 'deleted-agent' })).rejects.toThrow('not configured');
    await expect(discover({ gateway: { mode: 'remote', auth: { token: 'local-secret' } } }, { allowMissingConfig: true, fallbackConfiguration })).rejects.toThrow('remote Gateway');
  });

  it('does not fallback through unreadable or malformed config files', async () => {
    const options = { allowMissingConfig: true, fallbackConfiguration: connection };
    await expect(discover('not valid JSON5', options)).rejects.toThrow('could not be parsed');
    await expect(discover(null, { ...options, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).rejects.toThrow('could not be read');
  });

  it('marks trusted local diagnostics and sanitizes read errors even when they mimic a local message prefix', async () => {
    await expect(discover(base, { agentId: '../bad' })).rejects.toBeInstanceOf(OpenClawSetupError);
    const readFile = async () => { throw new Error(`OpenClaw configuration could not be parsed ${token}`); };
    try { await discover(base, { readFile }); throw new Error('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(OpenClawSetupError); expect(String(error)).not.toContain(token); }
  });

  it('does not silently connect to localhost for a remote-mode configuration', async () => {
    await expect(discover({ gateway: { mode: 'remote', remote: { url: 'wss://private.example' }, auth: { token } } })).rejects.toThrow('remote Gateway');
    await expect(discover({ gateway: { mode: 'remote', auth: { token } } }, { gatewayUrl: 'https://private.example' })).rejects.toThrow('remote Gateway');
    await expect(discover({ gateway: { mode: 'remote', auth: { token } } }, { gatewayUrl: 'https://private.example', gatewayToken: 'remote-secret' })).resolves.toMatchObject({ gatewayToken: 'remote-secret' });
  });

  it.each(['http://remote.example', 'https://private.example/path', 'https://user:password@private.example', 'https://private.example?secret=value', 'https://private.example/#fragment', 'not-an-origin', 'https://private.example\\'])('rejects unsafe Gateway origin %s without echoing its value', async gatewayUrl => {
    try { await discover(base, { gatewayUrl }); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).not.toContain(gatewayUrl); expect(String(error)).toContain('OpenClaw Gateway'); }
  });

  it.each(['http://localhost:18789', 'http://[::1]:18789', 'https://private.example'])('accepts private origin %s', async gatewayUrl => {
    await expect(discover(base, { gatewayUrl, gatewayToken: token })).resolves.toMatchObject({ gatewayUrl });
  });

  it('never forwards a discovered local credential to a remote override or configured URL', async () => {
    await expect(discover(base, { gatewayUrl: 'https://private.example' })).rejects.toThrow('explicit');
    await expect(discover({ ...base, gateway: { ...base.gateway, url: 'https://private.example' } })).rejects.toThrow('explicit');
  });

  it('rejects malformed data, executable expressions and ambiguous duplicate keys safely', async () => {
    for (const source of ['{gateway: (() => globalThis)()}', '{gateway: {auth: {token: "sensitive-secret"}', '{gateway: {}, gateway: {}}']) {
      await expect(discover(source)).rejects.toThrow('could not be parsed safely');
      try { await discover(source); } catch (error) { expect(String(error)).not.toContain('sensitive-secret'); }
    }
  });

  it('requires manual resolution of non-env secrets and handles missing env secrets without leaking credentials', async () => {
    for (const value of [{ source: 'exec', id: token }, { source: 'file', id: token }, { source: 'env', id: 'MISSING_TOKEN' }, '${MISSING_TOKEN}', '${bad-reference}']) {
      try { await discover({ gateway: { auth: { token: value } } }); throw new Error('expected rejection'); }
      catch (error) { expect(String(error)).toContain('OPENCLAW_GATEWAY_TOKEN'); expect(String(error)).not.toContain(token); }
    }
  });

  it('rejects line breaks in credentials, malformed ports, invalid agent IDs and unsupported auth modes', async () => {
    await expect(discover(base, { gatewayToken: 'secret\nvalue' })).rejects.toThrow('token is missing or invalid');
    await expect(discover({ gateway: { port: 'oops', auth: { token } } })).rejects.toThrow('port is invalid');
    await expect(discover(base, { agentId: '../../secret' })).rejects.toThrow('agent ID is invalid');
    await expect(discover({ gateway: { auth: { mode: 'password', token } } })).rejects.toThrow('OPENCLAW_GATEWAY_PASSWORD');
    await expect(discover({ gateway: { auth: { mode: 'tailscale', token } } })).rejects.toThrow('mode is not supported');
  });

  it('uses the Gateway password as the Bearer credential in password mode', async () => {
    const password = 'private-gateway-password';
    await expect(discover({ gateway: { auth: { mode: 'password', password, token } } })).resolves.toMatchObject({ gatewayToken: password });
    await expect(discover({ gateway: { auth: { mode: 'password' } } }, { env: { OPENCLAW_GATEWAY_PASSWORD: password } })).resolves.toMatchObject({ gatewayToken: password });
    await expect(discover({ gateway: { auth: { mode: 'password', password: { source: 'env', id: 'PRIVATE_PASSWORD' } } } }, { env: { PRIVATE_PASSWORD: password } })).resolves.toMatchObject({ gatewayToken: password });
    // OpenClaw selects password auth when no mode is set and a password exists.
    await expect(discover({ gateway: { auth: { password } } })).resolves.toMatchObject({ gatewayToken: password });
    await expect(discover({ gateway: { auth: { mode: 'password', password, token } } }, { env: { OPENCLAW_GATEWAY_TOKEN: 'stale-token' } })).resolves.toMatchObject({ gatewayToken: password });
    await expect(discover({ gateway: { auth: { mode: 'password', password, token } } }, { env: { OPENCLAW_GATEWAY_TOKEN: 'stale-token', OPENCLAW_GATEWAY_PASSWORD: 'active-password' } })).resolves.toMatchObject({ gatewayToken: 'active-password' });
    await expect(discover({ gateway: { auth: { mode: 'password', password } } }, { gatewayToken: 'explicit-bearer' })).resolves.toMatchObject({ gatewayToken: 'explicit-bearer' });
    try { await discover({ gateway: { auth: { mode: 'password', password: '${MISSING_PASSWORD}' } } }); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).toContain('OPENCLAW_GATEWAY_PASSWORD'); expect(String(error)).not.toContain(password); }
  });

  it('connects through the trusted-proxy local password fallback and explains unusable auth modes', async () => {
    const password = 'private-gateway-password';
    await expect(discover({ gateway: { auth: { mode: 'trusted-proxy', password } } })).resolves.toMatchObject({ gatewayToken: password });
    await expect(discover({ gateway: { auth: { mode: 'trusted-proxy' } } })).rejects.toThrow('trusted-proxy authentication without a local password');
    await expect(discover({ gateway: { auth: { mode: 'none' } } })).rejects.toThrow('gateway.auth.mode is "none"');
    await expect(discover({ gateway: { auth: { mode: 'none' } } })).rejects.toThrow('did not redeem an enrollment token');
    await expect(discover({ gateway: { auth: { mode: 'none' } } }, { gatewayToken: token })).rejects.toThrow('gateway.auth.mode is "none"');
  });

  it('recovers a saved password for the same local Gateway when its env reference is unavailable', async () => {
    const fallbackConfiguration = { ...connection, gatewayToken: 'saved-password' };
    const config = { gateway: { auth: { mode: 'password', password: '${GATEWAY_PASSWORD}' } } };
    await expect(discover(config, { allowMissingConfig: true, fallbackConfiguration })).resolves.toMatchObject({ gatewayToken: 'saved-password' });
  });

  it('requires resolved connection overrides for included configuration', async () => {
    await expect(discover({ ...base, $include: './gateway.json5' })).rejects.toThrow('includes other files');
    await expect(discover({ $include: './gateway.json5' }, { gatewayUrl: connection.gatewayUrl, gatewayToken: token, agentId: 'main' })).resolves.toMatchObject({ agentId: 'main' });
  });
});

describe('OpenClaw quick connect preflight', () => {
  it('runs a bounded authenticated agent turn without credentials in the body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completed());
    await preflightOpenClaw(connection, { fetch: fetcher });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18789/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'openclaw/main', stream: false });
    expect(body.user).toMatch(/^sinaloa:connection-test:/);
    expect(body.messages[0].content).toContain('Do not use tools');
    expect(init?.body).not.toContain(token);
  });

  it('rejects a known disabled endpoint before making any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(preflightOpenClaw({ ...connection, chatCompletionsEnabled: false }, { fetch: fetcher })).rejects.toThrow('chatCompletions.enabled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 405, 500])('reports HTTP %s safely and leaves enrollment untouched', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(`upstream included ${token}`, { status }));
    try { await preflightOpenClaw(connection, { fetch: fetcher }); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).not.toContain(token); expect(String(error)).toMatch(/Enrollment|enrollment token/); }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ choices: [] }, { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, { choices: [{ finish_reason: 'stop', message: { content: ' ' } }] }])('rejects incomplete completion %#', async payload => {
    await expect(preflightOpenClaw(connection, { fetch: async () => new Response(JSON.stringify(payload)) })).rejects.toThrow('completed text reply');
  });

  it('sanitizes thrown fetch errors and invalid JSON', async () => {
    await expect(preflightOpenClaw(connection, { fetch: async () => { throw new Error(`request headers ${token}`); } })).rejects.toThrow('could not be reached');
    await expect(preflightOpenClaw(connection, { fetch: async () => new Response(token) })).rejects.toThrow('invalid JSON');
    await expect(preflightOpenClaw(connection, { fetch: async () => { throw new Error(`OpenClaw ${token}`); } })).rejects.toBeInstanceOf(OpenClawSetupError);
  });

  it('bounds a hung request even if a fetch implementation ignores cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(preflightOpenClaw(connection, { fetch: fetcher, timeoutMs: 5 })).rejects.toThrow('timed out');
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('propagates cancellation and skips requests already canceled', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const work = preflightOpenClaw(connection, { fetch: fetcher, signal: stop.signal });
    stop.abort();
    await expect(work).rejects.toThrow('canceled');
    await expect(preflightOpenClaw(connection, { fetch: fetcher, signal: stop.signal })).rejects.toThrow('canceled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
