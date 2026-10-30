/** Deterministic real-SDK example. Only synthetic values enter the strict fetch. */
import assert from 'node:assert/strict';
import { EnvoiClient, EnvoiError, rotateAgentToken } from '../src/index.ts';

export const DEMO = {
  origin: 'https://offline.invalid',
  accessToken: 'synthetic-access-private',
  refreshToken: 'synthetic-refresh-private',
  inboxId: 'inbox_demo',
  agentId: 'agent_demo',
  caseId: 'case_offline_demo',
  startKey: 'start-demo-0001',
  eventKey: 'event-demo-0001',
  rotationId: 'rotation-demo-0001'
} as const;

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const firstMessage = {
  caseId: DEMO.caseId, senderAgentId: DEMO.agentId,
  recipientEmail: 'peer@envoi-agents.com', text: 'Offline hello', intent: 'request'
} as const;
const followUp = {
  caseId: DEMO.caseId, senderAgentId: DEMO.agentId,
  recipientEmail: 'peer@envoi-agents.com', text: 'Offline update', intent: 'status'
} as const;

/** Rejects any request beyond the exact seven-call scenario. */
export function createStrictOfflineFetch() {
  const requests: CapturedRequest[] = [];
  const messageUrl = `${DEMO.origin}/api/inboxes/${DEMO.inboxId}/messages`;
  const expected = [
    { url: messageUrl, method: 'POST', key: DEMO.startKey, body: firstMessage, auth: true },
    { url: messageUrl, method: 'POST', key: DEMO.startKey, body: firstMessage, auth: true },
    { url: messageUrl, method: 'POST', key: DEMO.eventKey, body: followUp, auth: true },
    { url: messageUrl, method: 'POST', key: DEMO.eventKey, body: followUp, auth: true },
    { url: `${DEMO.origin}/api/inboxes/${DEMO.inboxId}/events/delta?limit=2&cursor=cursor_before`, method: 'GET', key: null, body: null, auth: true },
    { url: `${DEMO.origin}/api/agent-token`, method: 'POST', key: null, body: { grantType: 'refresh_token', agentRefreshToken: DEMO.refreshToken, rotationId: DEMO.rotationId }, auth: false },
    { url: `${DEMO.origin}/api/agent-token`, method: 'POST', key: null, body: { grantType: 'refresh_token', agentRefreshToken: DEMO.refreshToken, rotationId: DEMO.rotationId }, auth: false }
  ];

  const fetcher: typeof fetch = async (input, init) => {
    const index = requests.length;
    const spec = expected[index];
    assert.ok(spec, 'unexpected additional request');
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    const snapshot: CapturedRequest = {
      url: String(input), method: init?.method || 'GET',
      headers: Object.fromEntries(headers.entries()), body
    };
    requests.push(snapshot);
    assert.equal(snapshot.url, spec.url, 'unexpected request URL');
    assert.equal(snapshot.method, spec.method, 'unexpected request method');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('idempotency-key'), spec.key);
    assert.equal(headers.get('authorization'), spec.auth ? `Bearer ${DEMO.accessToken}` : null);
    assert.deepEqual(body, spec.body, 'unexpected request body');

    // A lost response happens immediately, without a clock wait or network call.
    if (index === 0 || index === 2 || index === 5) throw new Error('synthetic lost response');
    if (index === 4) return new Response(JSON.stringify({ events: [], nextCursor: 'cursor_after', hasMore: false }), { status: 200 });
    if (index === 6) return new Response(JSON.stringify({
      agentApiToken: 'synthetic-next-access', agentRefreshToken: 'synthetic-next-refresh',
      agentTokenExpiresAt: '2030-01-01T00:00:00Z', agentRefreshTokenExpiresAt: '2030-02-01T00:00:00Z'
    }), { status: 200 });
    return new Response(JSON.stringify({ caseId: DEMO.caseId, status: 'queued' }), { status: 202 });
  };
  return { fetcher, requests };
}

export async function runOfflineQuickstart() {
  // In a real installation, persist these three identifiers before the first requests.
  const saved = { caseId: DEMO.caseId, startKey: DEMO.startKey, eventKey: DEMO.eventKey, rotationId: DEMO.rotationId };
  assert.notEqual(saved.startKey, saved.eventKey, 'distinct operations need distinct keys');
  const { fetcher, requests } = createStrictOfflineFetch();
  const client = new EnvoiClient(DEMO.origin, DEMO.accessToken, { fetch: fetcher, timeoutMs: 5_000 });

  await assert.rejects(client.startCase(DEMO.inboxId, saved.startKey, firstMessage),
    (error: unknown) => error instanceof EnvoiError && error.code === 'NETWORK_ERROR');
  const started = await client.startCase(DEMO.inboxId, saved.startKey, firstMessage);

  await assert.rejects(client.sendCaseEvent(DEMO.inboxId, saved.eventKey, followUp),
    (error: unknown) => error instanceof EnvoiError && error.code === 'NETWORK_ERROR');
  const sent = await client.sendCaseEvent(DEMO.inboxId, saved.eventKey, followUp);

  const delta = await client.delta(DEMO.inboxId, 'cursor_before', 2);

  await assert.rejects(rotateAgentToken(DEMO.origin, DEMO.refreshToken, saved.rotationId, { fetch: fetcher, timeoutMs: 5_000 }),
    (error: unknown) => error instanceof EnvoiError && error.code === 'NETWORK_ERROR');
  const rotated = await rotateAgentToken(DEMO.origin, DEMO.refreshToken, saved.rotationId, { fetch: fetcher, timeoutMs: 5_000 });

  // Keep credentials and token-bearing bodies out of this human-facing summary.
  const summary = `Offline SDK example: case ${started.status}, event ${sent.status}, ${delta.events.length} delta events, rotation expires ${rotated.agentTokenExpiresAt}.`;
  return { summary, requests };
}
