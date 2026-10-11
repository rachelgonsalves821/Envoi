import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../../integrations/contract-fixtures/setup';
import { request, api } from '../../../frontend/src/api';
import { EnvoiConnector, type ConnectorSession } from '../src/connector';
import { doctorConnection } from '../../../integrations/connector/core';
import { FileBridgeStore } from '../../../integrations/agent-bridges/file-store';

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(entry => entry.id === 'a5-presence' && entry.version === 1);
if (!contract?.schemas) throw new Error('Point ENVOI_CONTRACT_FIXTURES_ROOT at the canonical a5-presence publication');
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const fixtures = contract.fixtures.map(filename => loadContractFixture(contract, filename, source) as any);
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv); ajv.addSchema(schemas);
const validator = (name: string) => ajv.getSchema(`${schemas.$id}#/definitions/${name}`)!;
const byId = (id: string) => {
  const fixture = fixtures.find(value => value.id === id);
  if (!fixture) throw new Error(`Missing registered fixture ${id}`);
  return fixture;
};
const ownerFixtures = fixtures.filter(fixture => fixture.client.surface === 'owner_ui');
const statusFixtures = fixtures.filter(fixture => fixture.client.surface === 'connector');
const fields = ['lastSeenAt', 'lastSuccessfulRefreshAt', 'lastWorkClaimAt', 'lastProcessedAt'] as const;
type Presence = Record<typeof fields[number], string | null>;
type Connection = { state: string; asOf: string; recentWindowSeconds: number; seenAt: string | null;
  credentialExpiresAt: string | null; presence: Presence };
// Review-only consumer types: optional connection and open state values are intentional.
// Production frontend types and labels must wait for human contract approval.
type ReviewAgent = { id: string; status: string; onboardingStatus: string; paused: boolean;
  credentialRevoked: boolean; resumedAt?: string; connection?: Connection };
const agents = (fixture: any): ReviewAgent[] => Array.isArray(fixture.response.body) ? fixture.response.body : [fixture.response.body];
const agent = (id: string): ReviewAgent => structuredClone(agents(byId(id))[0]);
const age = (asOf: string, timestamp: string | null) => timestamp === null ? null : Math.max(0, Date.parse(asOf) - Date.parse(timestamp));

// Test-only reading of §4.2/§5, not a B-3 implementation or exported runtime API.
function projectedSeenAt(value: ReviewAgent): string | null {
  const connection = value.connection!;
  const claim = connection.presence.lastWorkClaimAt;
  const grace = value.resumedAt && Date.parse(connection.asOf) - Date.parse(value.resumedAt) <= connection.recentWindowSeconds * 1000
    && (!claim || Date.parse(claim) < Date.parse(value.resumedAt));
  return value.paused || grace ? connection.presence.lastSeenAt : claim;
}
function projectedState(value: ReviewAgent): string {
  const connection = value.connection!;
  if (value.status === 'revoked' || value.credentialRevoked) return 'revoked';
  if (value.onboardingStatus === 'rejected') return 'rejected';
  if (value.onboardingStatus !== 'approved') return 'pending_approval';
  if (connection.credentialExpiresAt === null) return 'not_connected';
  if (Date.parse(connection.credentialExpiresAt) <= Date.parse(connection.asOf)) return 'needs_reconnect';
  const seenAt = projectedSeenAt(value);
  if (seenAt === null) return 'never_seen';
  return age(connection.asOf, seenAt)! <= connection.recentWindowSeconds * 1000 ? 'seen_recently' : 'not_seen_recently';
}
function connectionLabel(value: ReviewAgent): string {
  if (!value.connection) return 'Status unknown';
  return schemas['x-connection-states'].find((row: any) => row.state === value.connection!.state)?.connectionLabel ?? 'Status unknown';
}
function agentLabel(value: ReviewAgent): string {
  if (value.status === 'revoked' || value.credentialRevoked) return 'Revoked';
  if (value.onboardingStatus === 'rejected') return 'Rejected';
  if (value.onboardingStatus !== 'approved') return 'Pending';
  return value.paused ? 'Paused' : 'Active';
}
const savedSession = (fixture: any): ConnectorSession => ({
  agentId: fixture.response.body.agent.id, inboxId: fixture.response.body.inboxId, address: fixture.response.body.agent.address,
  agentApiToken: fixture.request.headers.authorization.slice(7), agentRefreshToken: 'envoi_agent_refresh_PLACEHOLDER_review',
  agentTokenExpiresAt: '2999-01-01T00:00:00.000Z', agentRefreshTokenExpiresAt: '2999-01-01T00:00:00.000Z', cursor: null
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('a5-presence v1 fixture-only consumer review', () => {
  it('loads every registered fixture directly from the one shared source', async () => {
    expect(contract!.status).toMatch(/^(published|approved)$/);
    const actual = (await readdir(path.join(source, contract!.dir))).filter(name => name.endsWith('.json') && name !== contract!.schemas).sort();
    expect([...contract!.fixtures].sort()).toEqual(actual);
    expect(fixtures).toHaveLength(16); expect(ownerFixtures).toHaveLength(14); expect(statusFixtures).toHaveLength(2);
    expect(new Set(fixtures.map(fixture => fixture.id)).size).toBe(fixtures.length);
  });
  it.each(fixtures)('validates canonical $id producer shape and timestamp invariants', fixture => {
    const envelope = validator('fixture'); expect(envelope(fixture), JSON.stringify(envelope.errors)).toBe(true);
    const response = validator(fixture.response.schema); expect(response(fixture.response.body), JSON.stringify(response.errors)).toBe(true);
    expect(fixture.contract).toBe(contract!.id); expect(fixture.version).toBe(contract!.version);
    const projections = fixture.client.surface === 'owner_ui' ? agents(fixture).map(value => value.connection!) : [fixture.response.body];
    for (const projection of projections) {
      expect(Object.keys(projection.presence).sort()).toEqual([...fields].sort());
      for (const field of fields) {
        const timestamp = projection.presence[field];
        if (timestamp !== null) {
          expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.parse(projection.asOf));
          expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.parse(projection.presence.lastSeenAt));
        }
      }
    }
    expect(JSON.stringify(fixture.response.body)).not.toMatch(/envoi_(?:agent_access|agent_refresh|mcp_read|enroll)_/);
  });
  it.each(ownerFixtures)('consumes $id through real frontend transport and applies published label semantics', async fixture => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(fixture.request.path); expect(init?.credentials).toBe('same-origin');
      expect(init?.method ?? 'GET').toBe(fixture.request.method);
      return Response.json(fixture.response.body, { status: fixture.response.status });
    });
    vi.stubGlobal('fetch', fetcher);
    const body = await request<ReviewAgent[] | ReviewAgent>(fixture.request.path, { method: fixture.request.method });
    expect(body).toEqual(fixture.response.body);
    for (const value of Array.isArray(body) ? body : [body]) {
      expect(projectedSeenAt(value)).toBe(value.connection!.seenAt);
      expect(projectedState(value)).toBe(value.connection!.state);
      expect(connectionLabel(value)).toBe(fixture.client.connectionLabel);
      expect(agentLabel(value)).toBe(fixture.client.agentLabel);
      expect(connectionLabel(value)).not.toMatch(/\bonline\b|\brunning\b|\bEnrolled\b/);
      expect(value).not.toHaveProperty('pausedAt');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps the connection/agent precedence tables and exposure surfaces explicit', () => {
    expect(schemas['x-connection-states'].map((row: any) => row.state)).toEqual([
      'revoked', 'rejected', 'pending_approval', 'not_connected', 'needs_reconnect', 'never_seen', 'seen_recently', 'not_seen_recently'
    ]);
    expect(schemas['x-agent-labels'].map((row: any) => row.label)).toEqual(['Revoked', 'Rejected', 'Pending', 'Paused', 'Active']);
    expect(ownerFixtures.every(fixture => fixture.request.auth === 'human_session')).toBe(true);
    expect(statusFixtures.every(fixture => fixture.request.auth === 'agent_access' && fixture.request.path === '/api/agent/status')).toBe(true);
    expect(schemas['x-presence-throttle']).toMatchObject({ minIntervalSeconds: 60, recentWindowSeconds: 300 });
  });
  it.each(['missing', 'future-state', 'future-fields'])('accepts %s connection without inferring presence from approval', async variant => {
    const value = agent('owner-seen-recently');
    if (variant === 'missing') delete value.connection;
    else if (variant === 'future-state') value.connection!.state = 'future_state';
    else Object.assign(value.connection!, { futureField: { ignored: true } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([value])));
    const [received] = await request<ReviewAgent[]>('/api/inboxes/inbox_example/agents');
    expect(received).toEqual(value);
    expect(connectionLabel(received)).toBe(variant === 'future-fields' ? 'Seen recently' : 'Status unknown');
    expect(agentLabel(received)).toBe('Active');
    // Success-path producer schemas are deliberately stricter than forward-compatible consumers.
    expect(validator('ownerAgent')(value)).toBe(false);
  });
  it('accepts rollback or read-failure omission even when a paused agent was previously seen', async () => {
    const value = agent('owner-paused-seen-recently'); delete value.connection;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
    const received = await api.setAgentPaused('inbox_example', value.id, true) as unknown as ReviewAgent;
    expect(connectionLabel(received)).toBe('Status unknown'); expect(agentLabel(received)).toBe('Paused');
  });
  it('preserves an owner connection in the existing inbox-view transport', async () => {
    const value = agent('owner-seen-recently');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [value] })));
    const view = await api.humanView('inbox_example');
    expect(view.agents).toEqual([value]);
  });
  it('uses work-loop check-ins for active agents despite recent setup requests and refresh', () => {
    const value = agent('owner-never-seen');
    expect(value.connection!.presence.lastSeenAt).not.toBeNull();
    value.connection!.presence.lastSuccessfulRefreshAt = value.connection!.presence.lastSeenAt;
    expect(projectedSeenAt(value)).toBeNull(); expect(projectedState(value)).toBe('never_seen');
    expect(connectionLabel(value)).toBe('Not checked in yet');
    expect(projectedState(agent('owner-resume-grace-expired'))).toBe('not_seen_recently');
  });
  it('keeps paused-time check-ins for one inclusive resume window, then uses the work loop', () => {
    const value = agent('owner-resume-response'); const connection = value.connection!;
    connection.presence.lastSeenAt = value.resumedAt!;
    connection.asOf = new Date(Date.parse(value.resumedAt!) + 300000).toISOString();
    expect(projectedSeenAt(value)).toBe(value.resumedAt); expect(projectedState(value)).toBe('seen_recently');
    connection.asOf = new Date(Date.parse(connection.asOf) + 1).toISOString();
    expect(projectedSeenAt(value)).toBe(connection.presence.lastWorkClaimAt); expect(projectedState(value)).toBe('not_seen_recently');
    connection.presence.lastWorkClaimAt = value.resumedAt!;
    expect(projectedSeenAt(value)).toBe(value.resumedAt);
  });
  it('treats the recency threshold as inclusive and credential expiry as overriding recency', () => {
    const value = agent('owner-seen-recently'); const connection = value.connection!;
    connection.presence.lastWorkClaimAt = new Date(Date.parse(connection.asOf) - 300000).toISOString();
    expect(projectedState(value)).toBe('seen_recently');
    connection.presence.lastWorkClaimAt = new Date(Date.parse(connection.presence.lastWorkClaimAt) - 1).toISOString();
    expect(projectedState(value)).toBe('not_seen_recently');
    connection.credentialExpiresAt = connection.asOf;
    expect(projectedState(value)).toBe('needs_reconnect');
  });
  it('uses server asOf for ages, clamps negative ages and preserves never-null meaning', () => {
    vi.useFakeTimers(); vi.setSystemTime('2099-01-01T00:00:00.000Z');
    const connection = agent('owner-seen-recently').connection!;
    expect(age(connection.asOf, connection.seenAt)).toBe(42000);
    expect(age(connection.asOf, null)).toBeNull();
    expect(age(connection.asOf, new Date(Date.parse(connection.asOf) + 1000).toISOString())).toBe(0);
  });
  it('does not let pause or prior approval hide revocation or rejection', () => {
    const value = agent('owner-paused-seen-recently');
    value.credentialRevoked = true; value.onboardingStatus = 'rejected';
    expect(projectedState(value)).toBe('revoked'); expect(agentLabel(value)).toBe('Revoked');
    value.credentialRevoked = false;
    expect(projectedState(value)).toBe('rejected'); expect(agentLabel(value)).toBe('Rejected');
  });
  it('does not equate a successful claim or replayed completion with processed work', () => {
    const updates = schemas['x-presence-updates'];
    expect(updates.find((row: any) => row.outcome === '200 state claimed or idle').fields).toEqual(['lastSeenAt', 'lastWorkClaimAt']);
    expect(updates.find((row: any) => row.outcome === '200 state paused').fields).toEqual(['lastSeenAt']);
    expect(updates.find((row: any) => row.outcome === '201').fields).toEqual(['lastSeenAt', 'lastWorkClaimAt', 'lastProcessedAt']);
    expect(updates.find((row: any) => row.outcome === 'any other response except 409 AGENT_PAUSED').fields).not.toContain('lastProcessedAt');
    expect(schemas['x-presence-never'].join(' ')).toContain('mcp_read');
    expect(schemas['x-presence-never'].join(' ')).toContain('keepalives');
    expect(schemas['x-presence-never'].join(' ')).toContain('human request');
  });
  it.each(statusFixtures)('existing connector doctor/status accepts $id without presence driving lifecycle', async fixture => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-a5-review-'));
    try {
      const store = new FileBridgeStore(directory); await store.init(); await store.save(savedSession(fixture));
      await writeFile(path.join(directory, 'connection.json'), JSON.stringify({ version: 1, runtime: 'hermes',
        apiUrl: 'https://fixture.example', address: fixture.response.body.agent.address, agentName: 'Presence review', configuration: {} }));
      const calls: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = new URL(String(input)).pathname; calls.push(route);
        if (route === '/health') return Response.json({ ok: true, service: 'envoi' });
        expect(route).toBe('/api/agent/status'); expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error');
        expect((init?.headers as Record<string, string>).authorization).toBe(fixture.request.headers.authorization);
        return Response.json(fixture.response.body, { status: fixture.response.status });
      }) as typeof fetch;
      const statusReader = new EnvoiConnector('https://fixture.example', store, { fetch: fetcher });
      await statusReader.start(); await statusReader.checkStatus();
      expect((await store.load())?.lifecycle?.state).toBe(fixture.client.lifecycle);
      const result = await doctorConnection(directory, () => ({ runtime: 'hermes', discover: async () => ({}),
        preflight: async () => {}, describe: () => ({}), createBridge: async () => { throw new Error('Doctor must not start a bridge'); } }), { fetch: fetcher });
      expect(result.runtimeChecks).toBe('passed'); expect((await store.load())?.lifecycle?.state).toBe(fixture.client.lifecycle);
      expect(calls).toEqual(['/api/agent/status', '/health', '/api/agent/status']);
      expect(JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')).agentId).toBe(fixture.response.body.agent.id);
    } finally {
      expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
      expect(path.basename(directory)).toMatch(/^envoi-a5-review-/);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it.each(statusFixtures)('ignores stale or future diagnostic timestamps for $id lifecycle', async fixture => {
    let saved = savedSession(fixture);
    for (const timestamp of ['2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z']) {
      const body = structuredClone(fixture.response.body);
      for (const field of fields) body.presence[field] = timestamp;
      const connector = new EnvoiConnector('https://fixture.example', { load: async () => saved,
        save: async value => { saved = structuredClone(value); } }, { fetch: (async () => Response.json(body)) as typeof fetch });
      await connector.start(); await connector.checkStatus();
      expect(saved.lifecycle?.state).toBe(fixture.client.lifecycle);
    }
  });
});
