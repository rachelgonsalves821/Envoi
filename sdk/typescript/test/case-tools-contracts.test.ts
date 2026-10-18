import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

function publication(id: string) {
  const entry = contractRegistry.contracts.find(contract => contract.id === id);
  if (!entry || entry.version !== 1 || !['published', 'approved'].includes(entry.status)) throw new Error(`Missing publication: ${id} v1`);
  const fixtures = entry.fixtures.map(filename => loadContractFixture(entry, filename) as Record<string, any>);
  const schemas = loadContractFixture(entry, entry.schemas!) as Record<string, any>;
  const fixture = (name: string) => {
    const selected = fixtures.find(value => value.id === name);
    if (!selected) throw new Error(`Missing canonical fixture: ${id}/${name}`);
    return selected;
  };
  return { entry, fixtures, schemas, fixture };
}

const sessions = publication('case-session');
const tools = publication('case-tools');
const exchanges = (fixture: Record<string, any>): Record<string, any>[] => fixture.steps ?? (fixture.response ? [fixture] : []);
const result = (exchange: Record<string, any>) => {
  const envelope = exchange.response.body.result;
  expect(envelope.content).toHaveLength(1);
  expect(envelope.content[0].type).toBe('text');
  const payload = JSON.parse(envelope.content[0].text);
  expect(payload.ok).toBe(!envelope.isError);
  return payload;
};

describe('C-B0 canonical published client fixture consumption', () => {
  it('loads each registered fixture from its canonical path without a client copy', () => {
    expect(sessions.fixtures).toHaveLength(76);
    expect(tools.fixtures).toHaveLength(79);
    for (const publication of [sessions, tools]) {
      expect(new Set(publication.fixtures.map(fixture => fixture.id)).size).toBe(publication.fixtures.length);
      for (const fixture of publication.fixtures) {
        expect(fixture.contract).toBe(publication.entry.id);
        expect(fixture.version).toBe(1);
      }
    }
  });

  it.each(sessions.fixtures.filter(fixture => fixture.client?.modelVisible))('$id exposes only the contracted host-to-model projection', fixture => {
    const visible = fixture.client.modelVisible;
    expect(Object.keys(visible).sort()).toEqual(['agentAddress', 'allowedTools', 'counterpartyAddress', 'counterpartyKind', 'sessionExpiresInSeconds'].sort().filter(key => key !== 'counterpartyAddress' || fixture.response.body.session.counterparty.kind === 'agent'));
    expect(JSON.stringify(visible)).not.toMatch(/envoi_case_session_|lease_PLACEHOLDER|envoi_agent_(?:access|refresh)_|case_session_example|installation_example|msg_example|case_example/);
    expect(visible.allowedTools).toEqual(fixture.response.body.session.allowedTools);
    expect(visible.sessionExpiresInSeconds).toBeLessThanOrEqual(900);
    expect(visible.sessionExpiresInSeconds).toBeGreaterThan(0);
  });

  it.each(sessions.fixtures.filter(fixture => fixture.request?.auth === 'case_session' && fixture.request.path !== '/mcp'))('$id cannot use the model channel to perform a host operation', fixture => {
    expect(fixture.response.status).toBe(401);
    expect(fixture.response.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it.each(sessions.fixtures.flatMap(exchanges).filter(exchange => ['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED'].includes(exchange.response.body.code)))('consumes session invalidation as HTTP transport denial and turn cancellation', exchange => {
    expect(exchange.response.status).toBe(401);
    expect(exchange.response.body.result).toBeUndefined();
    expect(exchange.client.turn).toBe('cancel');
    expect(exchange.client.lifecycle).toBe('UNCHANGED');
  });

  it.each(tools.fixtures.flatMap(exchanges).filter(exchange => exchange.response.toolResult))('parses a single JSON-text tool result without operational credentials', exchange => {
    const payload = result(exchange);
    expect(typeof payload.ok).toBe('boolean');
    expect(payload.tool).toBe(exchange.request.body.params.name);
    expect(JSON.stringify(payload)).not.toMatch(/envoi_case_session_|envoi_agent_(?:access|refresh)_|lease_PLACEHOLDER/);
  });

  it('keeps uncertain reply retries on the same arguments and canonical message', () => {
    const [lost, replay] = tools.fixture('reply-lost-response').steps;
    expect(lost.delivered).toBe(false);
    expect(replay.request.body.params).toEqual(lost.request.body.params);
    const first = result(lost).result; const repeated = result(replay).result;
    expect(repeated).toEqual({ ...first, replayed: true });
    expect(first.replayed).toBe(false);
  });

  it('advertises the nine fully defined tools without placeholder inputs or results', () => {
    const fixture = tools.fixture('tools-list');
    expect(fixture.response.body.result.tools.map((tool: { name: string }) => tool.name))
      .toEqual(tools.schemas['x-tools'].map((tool: { name: string }) => tool.name));
    expect(fixture.response.body.result.tools).toHaveLength(9);
    for (const tool of tools.schemas['x-tools']) {
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.resultSchema).toBeTypeOf('string');
    }
    const snapshot = result(tools.fixture('snapshot-agent-work')).result;
    expect(snapshot.allowedActions).toEqual(['envoi_case_snapshot', 'envoi_case_reply', 'envoi_authority_check', 'envoi_case_list_assets', 'envoi_case_complete']);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(65536);
  });

  it('keeps recipient/case fields out of both implemented tool inputs', () => {
    for (const tool of tools.schemas['x-tools'].filter((tool: { revision: number }) => tool.revision === 1)) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const field of sessions.schemas['x-scope-fields']) expect(tool.inputSchema.properties).not.toHaveProperty(field);
    }
    const refused = tools.fixture('reply-recipient-override-rejected');
    expect(refused.response.body.error.data.code).toBe('TOOL_ARGUMENTS_INVALID');
  });

  it('keeps session and tool permission tables aligned across the stacked publications', () => {
    expect(tools.schemas['x-tools'].map(({ name, needs, workKinds }: any) => ({ name, needs, workKinds })))
      .toEqual(sessions.schemas['x-case-tools'].map(({ name, needs, workKinds }: any) => ({ name, needs, workKinds })));
  });

  it.each(tools.fixtures.filter(fixture => fixture.response?.toolResult === 'snapshotEnvelope'))('$id derives available actions from current proposal and authority state', fixture => {
    const snapshot = result(fixture).result;
    const expected = fixture.context.allowedTools.filter((name: string) => {
      if (['completed', 'failed', 'expired'].includes(snapshot.case.status)) return ['envoi_case_snapshot', 'envoi_case_list_assets'].includes(name);
      if (['envoi_case_snapshot', 'envoi_case_reply'].includes(name)) return true;
      if (name === 'envoi_case_propose') return snapshot.proposal === null;
      if (name === 'envoi_case_decide') return snapshot.proposal?.lastActor === 'other_agent';
      if (name === 'envoi_authority_check') return snapshot.proposal?.lastActor === 'other_agent' || !snapshot.authority.pendingHumanDecision;
      if (name === 'envoi_request_human') return snapshot.authority.lastPolicyDecision?.decision === 'needsHuman'
        && snapshot.authority.lastPolicyDecision.humanApproval === 'pending' && !snapshot.authority.pendingHumanDecision;
      if (name === 'envoi_case_list_assets') return true;
      if (name === 'envoi_case_share_asset') return snapshot.assetsHasMore || snapshot.assets.some((asset: any) => asset.origin === 'you' && asset.scan === 'clean' && !asset.shared);
      if (name === 'envoi_case_complete') return !snapshot.authority.pendingHumanDecision;
      return false;
    });
    expect(snapshot.allowedActions).toEqual(expected);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(tools.schemas['x-limits'].resultMaxBytes);
  });

  it('ends a requested human-decision turn instead of keeping the model waiting', () => {
    const requested = tools.fixture('request-human');
    expect(result(requested).result).toMatchObject({ status: 'pending', endTurn: true, replayed: false });
    expect(requested.client.turn).toBe('end');
    const authority = result(tools.fixture('authority-check-needs-human')).result;
    expect(authority).toMatchObject({ decision: 'needsHuman', humanApproval: 'pending' });
    expect(new Date(authority.expiresAt).getTime()).toBeGreaterThan(new Date('2026-10-17T12:00:00.000Z').getTime());
  });

  it.each(['snapshot-human-decision', 'snapshot-human-decision-declined'])('%s keeps the other agent as counterparty without exposing the deciding human', name => {
    const snapshot = result(tools.fixture(name)).result;
    expect(snapshot.requestedResponse).toMatchObject({ from: 'your_human', kind: 'human_decision' });
    expect(snapshot.counterparty).toEqual({ kind: 'agent', address: 'counterparty@envoi.mail' });
    expect(snapshot.case.status).toBe('inProgress');
    expect(JSON.stringify(snapshot)).not.toMatch(/humanId|senderHumanId|providerUserId|policyEvaluationId|installationId/);
  });

  it.each(['changed', 'expired', 'pending', 'denied'])('authority %s refuses an accept without converting it into success', suffix => {
    const fixture = tools.fixture(`decide-accept-authority-${suffix}`);
    const payload = result(fixture);
    expect(payload).toMatchObject({ ok: false, code: `AUTHORITY_${suffix.toUpperCase()}`, retryable: false });
    expect(payload.result).toBeUndefined();
    expect(fixture.client.lifecycle).toBe('UNCHANGED');
  });

  it('replays the original authority evaluation rather than granting new authority on retry', () => {
    const original = tools.fixture('authority-check-allow');
    const repeated = tools.fixture('authority-check-replayed');
    expect(repeated.request.body.params).toEqual(original.request.body.params);
    expect(result(repeated).result).toEqual({ ...result(original).result, replayed: true });
  });

  it('publishes an executable human-decision host claim before client adoption', () => {
    const claims = [...sessions.fixtures, ...tools.fixtures].flatMap(exchanges)
      .filter(exchange => exchange.request.path === '/api/agent/work/claim' && exchange.response.body.work?.message?.kind === 'humanDecision');
    expect(claims.length, 'Missing canonical humanDecision claim envelope for the new third WorkMessage kind').toBeGreaterThan(0);
  });

  it('publishes an executable human-decision session mint before client adoption', () => {
    const minted = sessions.fixtures.flatMap(exchanges).filter(exchange => exchange.response.body.session?.workKind === 'human_decision');
    expect(minted.length, 'Missing canonical human_decision mint and model projection').toBeGreaterThan(0);
  });

  it('binds the new human-decision claim to its minted case and other-agent counterparty', () => {
    const claimed = sessions.fixture('claimed-human-decision');
    const work = claimed.response.body.work;
    const minted = sessions.fixture('session-created-human-decision');
    expect(claimed.request.body).toEqual({});
    expect(work.message).toMatchObject({ kind: 'humanDecision', type: 'humanDecision', outcome: 'approved', action: 'proposal.accept' });
    expect(work.message.recipientInboxId).toBe(work.message.inboxId);
    expect(work.message.from).toEqual({ humanId: work.message.senderHumanId });
    expect(minted.request.path).toBe(`/api/agent/work/${work.workId}/session`);
    expect(minted.request.body).toEqual({ leaseToken: work.leaseToken });
    expect(minted.response.body.session).toMatchObject({
      workId: work.workId, caseId: work.message.caseId, agentId: work.message.recipientAgentId,
      workKind: 'human_decision', counterparty: { kind: 'agent', address: work.message.counterpartyAddress }
    });
    expect(minted.response.body.lease).toEqual({ workId: work.workId, leaseExpiresAt: work.leaseExpiresAt });
    expect(JSON.stringify(minted.client.modelVisible)).not.toMatch(/senderHumanId|humanId|requestId|policyEvaluationId|counterpartyAgentId|counterpartyInboxId/);
  });

  it.each(['share-asset', 'complete-case'])('%s replays the same operation without replacing the canonical result', name => {
    const original = tools.fixture(name);
    const repeated = tools.fixture(`${name}-replayed`);
    expect(repeated.request.body.params).toEqual(original.request.body.params);
    expect(result(repeated).result).toEqual({ ...result(original).result, replayed: true });
  });

  it('matches inline clean text bytes to the asset checksum without a download URL', () => {
    const payload = result(tools.fixture('list-asset-content')).result;
    expect(payload.asset.scan).toBe('clean');
    expect(payload.content.encoding).toBe('utf-8');
    expect(Buffer.byteLength(payload.content.text, 'utf8')).toBeLessThanOrEqual(tools.schemas['x-limits'].inlineContentMaxBytes);
    expect(createHash('sha256').update(payload.content.text, 'utf8').digest('base64')).toBe(payload.asset.checksumSha256);
    expect(payload.contentUnavailable).toBeNull();
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\/|assetId|inboxId|grantId|storageKey/);
  });

  it.each([['binary', 'binary'], ['too-large', 'too_large']])('leaves %s file bytes to the host rather than exposing them to the model', (suffix, reason) => {
    const payload = result(tools.fixture(`list-asset-content-${suffix}`)).result;
    expect(payload.content).toBeNull();
    expect(payload.contentUnavailable).toBe(reason);
  });

  it.each(['not-clean', 'infected'])('refuses %s inline file content', suffix => {
    expect(result(tools.fixture(`list-asset-content-${suffix}`))).toMatchObject({ ok: false, code: 'ASSET_NOT_CLEAN', retryable: false });
  });

  it('does not reveal whether an inaccessible asset belongs to another tenant', () => {
    expect(result(tools.fixture('list-asset-other-tenant'))).toEqual(result(tools.fixture('list-asset-ungranted')));
  });

  it.each([['not-clean', 'ASSET_NOT_CLEAN'], ['not-yours', 'ASSET_NOT_SHAREABLE']])('refuses %s sharing without a new grant', (suffix, code) => {
    expect(result(tools.fixture(`share-asset-${suffix}`))).toMatchObject({ ok: false, code, retryable: false });
  });

  it('keeps case completion distinct from lease settlement and hides the human action id', () => {
    const fixture = tools.fixture('complete-case-after-human-approval');
    const payload = result(fixture).result;
    expect(payload).toMatchObject({ caseStatus: 'completed', humanApproval: 'approved' });
    expect(payload.receiptRef).toMatch(/^r_[a-z2-7]{16}$/);
    expect(JSON.stringify(payload)).not.toMatch(/authorityBasis|policyEvaluationId|leaseToken|workId|senderHumanId/);
    expect(fixture.request.path).toBe('/mcp');
    expect(fixture.request.body.params.name).toBe('envoi_case_complete');
    expect(result(tools.fixture('complete-case-result-changed'))).toMatchObject({ ok: false, code: 'AUTHORITY_CHANGED' });
    expect(result(tools.fixture('complete-case-evidence-not-shared'))).toMatchObject({ ok: false, code: 'EVIDENCE_NOT_SHARED' });
    expect(result(tools.fixture('complete-case-authority-required'))).toMatchObject({ ok: false, code: 'AUTHORITY_REQUIRED' });
  });

  it('keeps a closed case read-only and refuses fresh completion or reply effects', () => {
    const snapshot = result(tools.fixture('snapshot-completed')).result;
    expect(snapshot.allowedActions).toEqual(['envoi_case_snapshot', 'envoi_case_list_assets']);
    for (const name of ['complete-case-closed', 'reply-case-closed']) expect(result(tools.fixture(name))).toMatchObject({ ok: false, code: 'CASE_CLOSED' });
  });
});
