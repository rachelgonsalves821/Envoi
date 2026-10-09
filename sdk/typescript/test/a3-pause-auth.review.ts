import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SinaloaConnector, type ConnectorSession } from '../src/connector';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../../integrations/contract-fixtures/setup';

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const registry = loadContractRegistry(source);
const contract = registry.contracts.find(item => item.id === 'a3-pause-auth' && item.version === 1);
if (!contract?.schemas) throw new Error('a3-pause-auth v1 publication is required; set ENVOI_CONTRACT_FIXTURES_ROOT to its canonical fixture directory');

interface Fixture {
  contract: string; version: number; id: string; kind: 'http' | 'sse' | 'network';
  request?: { method: string; path: string; body?: Record<string, unknown> };
  response?: { status: number; schema: string; headers?: Record<string, string>; body?: any; bodyText?: string };
  event?: { schema: string; id?: string; event: string; data: Record<string, any> };
  network?: { error: string };
  client: { lifecycle: string; retry: string; guidance: string; next: string };
}
const fixtures = contract.fixtures.map(filename => loadContractFixture(contract, filename, source) as Fixture);
const byId = (id: string) => {
  const found = fixtures.find(item => item.id === id);
  if (!found) throw new Error('Missing required fixture: ' + id);
  return found;
};
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const validate = (definition: string, value: unknown) => {
  const check = ajv.getSchema(schemas.$id + '#/definitions/' + definition);
  if (!check) throw new Error('Unknown fixture schema: ' + definition);
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
};

// Independent acceptance expectations. B-1 must drive its real lifecycle from these fixtures.
const codes: Record<string, [number, string, string, string]> = {
  AGENT_PAUSED: [409, 'PAUSED', 'after_resume', 'wait_for_resume'],
  CREDENTIAL_REVOKED: [401, 'REVOKED', 'none', 'owner_reenroll'],
  CREDENTIAL_EXPIRED: [401, 'NEEDS_RECONNECT', 'none', 'owner_reconnect'],
  ACCESS_TOKEN_EXPIRED: [401, 'UNCHANGED', 'refresh_then_retry_once', 'none'],
  AUTHENTICATION_REQUIRED: [401, 'UNCHANGED', 'refresh_then_retry_once', 'none'],
  ROTATION_ID_REQUIRED: [400, 'NEEDS_RECONNECT', 'none', 'update_connector'],
  REFRESH_TOKEN_INVALID: [401, 'NEEDS_RECONNECT', 'none', 'owner_reconnect'],
  REFRESH_REPLAY: [401, 'REVOKED', 'none', 'owner_reenroll'],
  REFRESH_RECOVERY_EXPIRED: [401, 'NEEDS_RECONNECT', 'none', 'owner_reconnect'],
  CASE_CONTROLLED: [409, 'UNCHANGED', 'after_case_resume', 'case_paused'],
  ACCOUNT_CHANGED: [409, 'NOT_APPLICABLE', 'none', 'reload_browser'],
  RATE_LIMITED: [429, 'DEGRADED', 'after_retry_after', 'service_busy'],
  INTERNAL_SERVER_ERROR: [500, 'DEGRADED', 'backoff', 'service_unavailable'],
  AUTH_UNAVAILABLE: [503, 'DEGRADED', 'backoff', 'service_unavailable']
};
afterEach(() => vi.restoreAllMocks());

describe('a3-pause-auth v1 published client acceptance', () => {
  it('loads every registered fixture and the required code/pause/reconnect/event cases', () => {
    expect(fixtures).toHaveLength(contract.fixtures.length);
    expect(fixtures.length).toBeGreaterThanOrEqual(39);
    expect(new Set(fixtures.map(item => item.id)).size).toBe(fixtures.length);
    for (const id of ['claimed-work', 'paused-claim', 'paused-refresh', 'reconnect-while-paused', 'rate-limited', 'refresh-replay', 'case-ordering-reply-accepted', 'cancel-held-message', 'event-agent-paused', 'event-agent-resumed', 'event-work-available', 'event-credential-ended']) expect(byId(id)).toBeDefined();
  });

  it.each(fixtures)('consumes $id with its declared schema and stable lifecycle policy', fixture => {
    expect(fixture.contract).toBe('a3-pause-auth');
    expect(fixture.version).toBe(1);
    validate('fixture', fixture);
    if (fixture.response) {
      const response = fixture.response;
      validate(response.schema, response.body ?? response.bodyText);
      if (response.schema === 'errorEnvelope') {
        const body = response.body;
        const expected = codes[body.code];
        expect(expected, 'unknown stable code').toBeDefined();
        expect(response.status).toBe(expected[0]);
        expect(body.error).toBe(body.code);
        expect(body.message).not.toBe(body.code);
        expect(fixture.client).toMatchObject({ lifecycle: expected[1], retry: expected[2], guidance: body.reason === 'replaced' ? 'replaced_by_reconnect' : expected[3] });
        if (body.code === 'RATE_LIMITED') expect(Number(response.headers?.['retry-after'])).toBe(body.retryAfterSeconds);
      }
    } else if (fixture.event) {
      const event = fixture.event;
      validate(event.schema, event.data);
      if (event.event === 'credential.ended') {
        expect(event.id).toBeUndefined();
        expect(fixture.client.lifecycle).toBe(codes[event.data.code][1]);
        expect(fixture.client.retry).toBe('none');
      } else {
        expect(event.id).toBe(event.data.cursor);
        expect(event.event).toBe(event.data.type);
      }
    } else {
      expect(fixture.network?.error).toBeTruthy();
      expect(fixture.client).toMatchObject({ lifecycle: 'DEGRADED', retry: 'backoff', guidance: 'service_unavailable' });
      expect(fixture.request?.body?.rotationId).toBeTruthy();
    }
  });

  it('distinguishes paused claim from idle without treating refresh as resume', () => {
    expect(byId('paused-claim').response?.body).toEqual({ work: null, state: 'paused' });
    expect(byId('paused-claim').client).toMatchObject({ lifecycle: 'PAUSED', retry: 'after_resume' });
    expect(byId('idle-claim').response?.body).toEqual({ work: null, state: 'idle' });
    expect(byId('paused-refresh').client.lifecycle).toBe('UNCHANGED');
    expect(byId('paused-refresh').response?.body).not.toHaveProperty('state');
    expect(byId('paused-status').response?.body).toMatchObject({ state: 'paused', agent: { status: 'paused' } });
  });

  it('preserves pause through reconnect and allows immediate claims after resume', () => {
    expect(byId('reconnect-while-paused').response?.body.agent.status).toBe('paused');
    expect(byId('reconnect-while-paused').client).toMatchObject({ lifecycle: 'PAUSED', retry: 'after_resume' });
    expect(byId('event-agent-paused').client.lifecycle).toBe('PAUSED');
    expect(byId('event-agent-resumed').client.lifecycle).toBe('RUNNING');
    expect(byId('event-work-available').event?.data.reason).toBe('agent_resumed');
  });

  it('accepts held/cancelled records while keeping the D1 barrier private to its owner', () => {
    expect(byId('sender-paused-held-message').response?.body[0]).toMatchObject({ status: 'held', heldReason: 'sender_paused' });
    expect(byId('cancel-held-message').response?.body.status).toBe('cancelled');
    for (const id of ['case-ordering-reply-accepted', 'paused-recipient-accepted']) {
      const fixture = byId(id);
      expect(fixture.response?.status).toBe(202);
      expect(fixture.response?.body.status).toBe('queued');
      for (const key of ['heldReason', 'heldBehindMessageId', 'heldAt']) expect(fixture.response?.body).not.toHaveProperty(key);
    }
  });

  it('consumes the claimed-work response through the existing fenced SDK handler', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T12:00:00.000Z'));
    const fixture = byId('claimed-work');
    const initial: ConnectorSession = {
      agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@sinaloa.mail', cursor: null,
      agentApiToken: 'access-placeholder', agentRefreshToken: 'refresh-placeholder',
      agentTokenExpiresAt: '2026-10-08T13:00:00.000Z', agentRefreshTokenExpiresAt: '2026-11-07T12:00:00.000Z'
    };
    const admit = vi.fn(), process = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/claim')) return Response.json(fixture.response?.body, { status: fixture.response?.status });
      const acknowledged = String(url).endsWith('/acknowledge');
      if (!acknowledged && !String(url).endsWith('/complete')) throw new Error('Unexpected request: ' + url);
      const state = acknowledged ? 'acknowledged' : 'processed';
      return Response.json({ workId: 'msg_example', status: state, receipt: { messageId: 'msg_example', state } });
    });
    const connector = new SinaloaConnector('https://fixture.example', { load: async () => initial, save: async () => {} }, {
      fetch: fetcher as typeof fetch, handler: { admit, process }
    });
    await expect(connector.processWorkOnce()).resolves.toBe(true);
    expect(admit).toHaveBeenCalledWith(fixture.response?.body.work.message);
    expect(process).toHaveBeenCalledOnce();
  });
});
