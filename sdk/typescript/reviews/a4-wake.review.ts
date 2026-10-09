import path from 'node:path';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { SinaloaConnector, type ConnectorSession } from '../src/connector';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../../integrations/contract-fixtures/setup';

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'a4-wake' && item.version === 1);
if (!contract?.schemas) throw new Error('a4-wake v1 publication required; point ENVOI_CONTRACT_FIXTURES_ROOT at the publishing worktree canonical test/contract-fixtures directory');
const fixtures = contract.fixtures.map(file => loadContractFixture(contract, file, source) as any);
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const check = (schema: string, value: unknown) => {
  const validator = ajv.getSchema(`${schemas.$id}#/definitions/${schema}`);
  expect(validator, schema).toBeDefined();
  expect(validator!(value), JSON.stringify(validator!.errors)).toBe(true);
};
const byId = (id: string) => {
  const fixture = fixtures.find(item => item.id === id);
  if (!fixture) throw new Error('Missing fixture: ' + id);
  return fixture;
};
const requestCursor = (fixture: any): string | null => fixture.request?.headers?.['last-event-id']
  || new URL(fixture.request?.path || '/', 'https://fixture.example').searchParams.get('cursor');

// Fixture consumption and protocol acceptance only. No B-2 transport/timers are implemented.
describe('published a4-wake v1 client review', () => {
  it('loads all 26 fixtures from their registered canonical source', () => {
    expect(fixtures).toHaveLength(26);
    expect(new Set(fixtures.map(item => item.id)).size).toBe(26);
    expect(schemas['x-work-available-reasons']).toEqual(['agent_resumed', 'case_resumed', 'counterparty_resumed', 'lease_released']);
  });

  it.each(fixtures)('consumes $id schemas, cursor ordering and stable codes', fixture => {
    check('fixture', fixture);
    expect(fixture.client.claim).toBeTypeOf('boolean');
    if (fixture.response) {
      check(fixture.response.schema, fixture.response.body);
      const { body, status } = fixture.response;
      if (body.code) {
        const policy = schemas['x-codes'][body.code];
        expect(policy).toBeDefined();
        expect(status).toBe(policy.status);
        expect(body.error).toBe(body.code);
        expect(fixture.client).toMatchObject({ lifecycle: policy.lifecycle, retry: policy.retry, guidance: policy.guidance });
      }
      if (fixture.response.schema === 'deltaPage') {
        let cursor = requestCursor(fixture);
        for (const event of body.events) {
          expect(event.cursor).toBe(String(event.sequence).padStart(20, '0'));
          if (cursor) expect(event.cursor > cursor).toBe(true);
          cursor = event.cursor;
        }
        expect(body.nextCursor).toBe(cursor);
        if (body.hasMore) expect(body.events.length).toBeGreaterThan(0);
      }
    }
    if (fixture.event) {
      check(fixture.event.schema, fixture.event.data);
      expect(fixture.event.id).toBe(fixture.event.data.cursor);
      expect(fixture.event.event).toBe(fixture.event.data.type);
    }
    if (fixture.frames) {
      let cursor = requestCursor(fixture);
      for (const frame of fixture.frames) {
        if (frame.comment) { expect(frame.id).toBeUndefined(); continue; }
        check(frame.schema, frame.data);
        if (frame.id) {
          expect(frame.id).toBe(frame.data.cursor);
          expect(frame.id).toBe(String(frame.data.sequence).padStart(20, '0'));
          expect(frame.event).toBe(frame.data.type);
          if (cursor) expect(frame.id > cursor).toBe(true);
          cursor = frame.id;
        } else {
          expect(['ready', 'replay_required', 'replay_error', 'credential.ended']).toContain(frame.event);
          // The producer's from=latest row explicitly reports newest rather than last replayed.
          if (['ready', 'replay_required'].includes(frame.event) && fixture.id !== 'stream-from-latest') expect(frame.data.cursor).toBe(cursor);
        }
      }
    }
  });

  it('distinguishes own-send observation from inbound work wakes', () => {
    const inbound = byId('event-message-delivered-to-agent');
    const own = byId('event-message-delivered-own-send');
    expect(inbound.event.data.recipientAgentId).toBe('agent_example');
    expect(inbound.client.claim).toBe(true);
    expect(own.event.data.senderAgentId).toBe('agent_example');
    expect(own.event.data.recipientAgentId).not.toBe('agent_example');
    expect(own.client.claim).toBe(false);
    for (const id of ['event-work-available-case-resumed', 'event-work-available-counterparty-resumed', 'event-work-available-lease-released']) expect(byId(id).client.claim).toBe(true);
  });

  it.each(['fresh', 'EVENT_CURSOR_INVALID reset'])('consumes the explicit from=latest baseline for %s', reason => {
    const fixture = byId('stream-from-latest');
    expect(fixture.request.path).toContain('from=latest');
    expect(fixture.client.next).toMatch(/baseline/i);
    let cursor: string | null = reason === 'fresh' ? null : '99999999999999999999';
    const ready = fixture.frames.find((frame: any) => frame.event === 'ready');
    expect(ready.id).toBeUndefined();
    cursor = ready.data.cursor; // Fixture-only acceptance model, not B-2 implementation.
    expect(cursor).toBe('00000000000000000044');
    expect(fixture.client.claim).toBe(true);
    expect(byId('stream-cursor-invalid').client.next).toContain('from=latest');
  });

  it('ordinary control frames leave the processed cursor unchanged', () => {
    for (const id of ['stream-resume-last-event-id', 'stream-replay-required', 'stream-replay-error', 'stream-credential-ended']) {
      const fixture = byId(id);
      let cursor = requestCursor(fixture);
      for (const frame of fixture.frames) {
        const previous = cursor;
        if (frame.id) cursor = frame.id;
        else expect(cursor).toBe(previous);
      }
    }
    const resume = byId('stream-resume-last-event-id');
    expect(resume.client.next).toContain('ready does not move the stored cursor');
  });

  it('publication prose explicitly limits the baseline exception to fresh or invalid-cursor reset connections', () => {
    const handoff = readFileSync(path.resolve(source, '../../docs/architecture/agent-native-v2/handoffs.md'), 'utf8');
    const a4 = handoff.slice(handoff.indexOf('## a4-wake v1'));
    expect(a4).toContain('**Normal rule:**');
    expect(a4).toContain('**Baseline exception:**');
    expect(a4).toContain('inbox has no stored cursor or the client is resetting after `EVENT_CURSOR_INVALID`');
    expect(a4).toContain('If `ready.cursor` is `null`, the stored cursor stays empty until the first event');
  });

  it('requires closed producer wake events without human identity and caseId only for case_resumed', () => {
    const wake = byId('event-work-available-case-resumed').event.data;
    const validator = ajv.getSchema(`${schemas.$id}#/definitions/workAvailableEvent`)!;
    expect(validator({ ...wake, humanId: 'private-owner' })).toBe(false);
    const { caseId, ...missingCase } = wake;
    expect(validator(missingCase)).toBe(false);
    expect(validator({ ...missingCase, reason: 'counterparty_resumed' })).toBe(true);
    expect(validator({ ...wake, reason: 'counterparty_resumed' })).toBe(false);
  });

  it('separates immediate claims from hint scheduling and suppresses paused hints', () => {
    const hinted = byId('claim-idle-next-available');
    expect(hinted.client.claim).toBe(false);
    expect(hinted.response.body.nextAvailableInMs).toBe(30000);
    expect(Date.parse(hinted.response.body.nextAvailableAt)).toBe(Date.parse('2026-10-09T12:00:00Z') + hinted.response.body.nextAvailableInMs);
    const paused = byId('claim-paused-no-hint');
    expect(paused.client).toMatchObject({ lifecycle: 'PAUSED', claim: false, retry: 'after_resume' });
    expect(paused.response.body).not.toHaveProperty('nextAvailableAt');
    expect(paused.response.body).not.toHaveProperty('nextAvailableInMs');
    expect(paused.client.next).toContain('/api/agent/status');
  });

  it.each(['delta-page-more', 'delta-last-page', 'delta-empty-after-cursor'])('consumes %s through the existing SDK without claims or token rotation', async id => {
    const fixture = byId(id);
    let session: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
      agentApiToken: 'private-access', agentRefreshToken: 'private-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), cursor: requestCursor(fixture) };
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      requests.push(String(input));
      expect(String(input)).toContain('/api/inboxes/inbox_example/events/delta?');
      return Response.json(fixture.response.body);
    }) as typeof fetch;
    const seen: string[] = [];
    const connector = new SinaloaConnector('https://fixture.example', { load: async () => session, save: async next => { session = next; } }, {
      fetch: fetcher, onEvent: event => { seen.push(event.cursor); }
    });
    await expect(connector.pollOnce()).resolves.toEqual({ count: fixture.response.body.events.length, hasMore: fixture.response.body.hasMore });
    expect(seen).toEqual(fixture.response.body.events.map((event: any) => event.cursor));
    expect(session.cursor).toBe(fixture.response.body.nextCursor);
    expect(requests).toHaveLength(1);
    expect(session.agentRefreshToken).toBe('private-refresh');
  });
});
