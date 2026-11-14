import { afterEach, expect, it, vi } from 'vitest';
import { EnvoiConnector } from '../../../../sdk/typescript/src/connector';
import { localServer } from './local-server.mjs';
import { glue, selected } from './v4-glue.mjs';
import { api, claim, eventually, owner, ownerEvents, ownerMessages, send, waitForMessageStatus } from '../../../../test/a3-harness.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closers.splice(0)) await close(); });
async function start() {
  const server = await localServer(); closers.push(server.stop);
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '7001'), owner(server.baseUrl, '7002')]);
  return { server, alice, bob, base: server.baseUrl };
}
async function tool(base, session, name, args = {}) {
  const result = await api(base, '/mcp', { token: session.token, headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(result.status, result.text).toBe(200);
  return JSON.parse(result.payload.result.content[0].text);
}
async function okTool(base, session, name, args = {}) {
  const value = await tool(base, session, name, args); expect(value.ok, JSON.stringify(value)).toBe(true); return value.result;
}
async function mint(base, who, work) {
  const result = await api(base, `/api/agent/work/${work.workId}/session`, { token: who.agentApiToken, body: { leaseToken: work.leaseToken } });
  expect(result.status, result.text).toBe(201); return result.payload.session;
}
async function settle(base, who, work) {
  const result = await api(base, `/api/agent/work/${work.workId}/complete`, { token: who.agentApiToken,
    key: 'settle-' + work.workId, body: { leaseToken: work.leaseToken } });
  expect([200, 201]).toContain(result.status); return result.payload;
}
async function proposal(base, alice, bob, caseId) {
  const sent = await send(base, alice, bob, { caseId, text: 'Synthetic offline offer request' }); expect(sent.status).toBe(202);
  await waitForMessageStatus(base, bob, sent.payload.id, 'delivered');
  const work = (await claim(base, bob.agentApiToken)).payload.work; expect(work.workId).toBe(sent.payload.id);
  const session = await mint(base, bob, work);
  await okTool(base, session, 'envoi_case_propose', { text: 'Synthetic offer', terms: { accentColor: 'green' }, idempotencyKey: 'offer-' + caseId });
  await settle(base, bob, work);
  const result = await eventually(async () => (await ownerMessages(base, alice, caseId)).find(m => m.type === 'proposal' && m.recipientAgentId === alice.agent.id));
  await waitForMessageStatus(base, alice, result.id, 'delivered'); return result;
}
async function snapshot(base, who, caseId) {
  const c = await api(base, `/api/inboxes/${who.inbox.id}/cases/${caseId}`, { session: who.session }); expect(c.status).toBe(200);
  const messages = await ownerMessages(base, who, caseId);
  return { ids: messages.map(m => m.id), record: { case: c.payload, messages } };
}

for (const [fileFirst, oldExpiry, oldFifo] of [[false, false, false], [true, false, false], [false, true, false], [true, false, true]]) it(`incidents 3,5,6,7,8: assembled decision flow uses real server FIFO, retry, expiry and no-action settlement (${oldFifo ? 'old fixed order refuses' : oldExpiry ? 'old expiry refuses' : fileFirst ? 'file first' : 'authority first'})`, async () => {
  const { server, base, alice, bob } = await start(), apiGlue = glue();
  const transport: { path: string; method: string; tool?: string; scoped: boolean }[] = [], network = globalThis.fetch;
  vi.stubGlobal('fetch', async (input, init) => {
    const url = new URL(String(input)); expect(url.origin, 'offline transport must stay on the disposable server').toBe(base);
    let body; try { body = JSON.parse(String(init?.body)); } catch {}
    transport.push({ path: url.pathname, method: init?.method || 'GET', tool: body?.params?.name, scoped: new Headers(init?.headers).get('authorization')?.startsWith('Bearer envoi_case_session_') === true });
    return network(input, init);
  });
  const green = await proposal(base, alice, bob, 'case_synthetic_green'), file = await proposal(base, alice, bob, 'case_synthetic_file');
  // Set only the clock facts of disposable messages; the production claim handler
  // still chooses the work across cases.
  const earlier = new Date(Date.now() - 2000).toISOString(), later = new Date(Date.now() - 1000).toISOString();
  for (const [m, at] of [[green, fileFirst ? later : earlier], [file, fileFirst ? earlier : later]] as any[])
    await server.edit(['inboxes', alice.inbox.id, 'messages', m.id + '.json'], v => ({ ...v, deliveredAt: at }));
  const realNow = Date.now.bind(Date); let now = realNow(), offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  const advance = async ms => { offset += ms; now = Date.now(); await server.advance(ms); };
  const g = glue(oldExpiry ? { bounds: selected.segments.bounds.source.replace('expiry=now+360000', 'expiry=now+240000') } : {}, async ms => advance(ms));
  const plan = { flowCases: { 'accept-authority': green.caseId, 'asset-decline': file.caseId, 'declined-resume': green.caseId }, controls: { testowner: { authorityExpiry: 'synthetic-expiry' } } };
  const trace: string[] = []; let bounds, originalSession, originalWork, selectedAuthority, expiryStart = -1;
  const c: any = { plan, actors: { testowner: { agentId: alice.agent.id } }, live() {},
    controller: { receipt: { hardStopUtc: new Date(now + 1800000).toISOString() }, control: { signal: new AbortController().signal } },
    ownerInstructions: { post: async instruction => { expect(instruction.text).toContain('Leave every other pending request untouched'); trace.push('announce'); } },
    snapshot: async (role, caseId) => snapshot(base, alice, caseId),
    effect: async flow => flow === 'oc-canary-no-action' ? green : file,
    exactIncoming: async x => ({ ...x, caseId: plan.flowCases[x.flowId], workId: x.workId || x.parentEffect?.id }),
    claimOrder: (...args) => oldFifo ? args[1] : g.conductor.claimOrder.call(c, ...args),
    announceHumanDecision: (...args) => g.conductor.announceHumanDecision.call(c, ...args),
    pauseFor: ms => g.conductor.pauseFor.call(c, ms),
    runGroup: async ([binding]) => {
      if (binding.flowId === 'declined-resume') { trace.push('resume'); return [await resumeNoAction(binding)]; }
      const work = (await claim(base, alice.agentApiToken)).payload.work; expect(work?.workId, 'actual canonical FIFO').toBe(binding.workId);
      const session = await mint(base, alice, work), shown = await okTool(base, session, 'envoi_case_snapshot');
      const full = await snapshot(base, alice, binding.caseId), p = full.record.case.proposals.find(x => x.status === 'open');
      if (binding.flowId === 'accept-authority') {
        bounds = g.bounds(c.controller);
        // Same real REST interface used by the operator's one-use fixture. The
        // approval envelope is not simulated as endpoint output.
        const evaluation = await api(base, `/api/inboxes/${alice.inbox.id}/cases/${binding.caseId}/policy-evaluations`, { token: alice.agentApiToken,
          body: { requestedAction: 'proposal.accept', actionPayload: { proposalId: p.id, optionId: p.options[0].id }, expiresAt: new Date(bounds.expiry).toISOString(), grantType: 'oneTime' } });
        expect(evaluation.status, evaluation.text).toBe(201);
        const fresh = await okTool(base, session, 'envoi_case_snapshot'); selectedAuthority = fresh.authority.lastPolicyDecision.authorityRef;
        await okTool(base, session, 'envoi_request_human', { authorityRef: selectedAuthority, question: 'Synthetic offline authority request', idempotencyKey: 'request-' + binding.caseId });
        originalSession = session; originalWork = work;
      } else {
        const authority = await okTool(base, session, 'envoi_authority_check', { action: 'accept_proposal', proposalRef: shown.proposal.ref, optionRef: shown.proposal.options[0].ref, idempotencyKey: 'check-file' });
        await okTool(base, session, 'envoi_request_human', { authorityRef: authority.authorityRef, question: 'Leave this synthetic request pending', idempotencyKey: 'request-file' });
      }
      await settle(base, alice, work); trace.push(binding.flowId); await advance(120000); return [binding];
    },
    waitHumanDecision: async () => {
      await advance(30000);
      const event = (await ownerEvents(base, alice)).find(e => e.type === 'case.human_decision_requested' && e.caseId === green.caseId);
      const result = await api(base, `/api/inboxes/${alice.inbox.id}/cases/${green.caseId}/actions`, { session: alice.session, key: 'decline-synthetic',
        body: { actionKey: 'decline', externalRefs: { policyEvaluationId: event.policyEvaluationId } } });
      if (oldExpiry) {
        expect(now).toBeGreaterThan(bounds.expiry);
        expect(result.status, result.text).toBe(409);
        throw new Error('C08_DECLINE_EXPIRED_BEFORE_REVIEW');
      }
      expect(now).toBeLessThan(bounds.expiry);
      if (!fileFirst) expect(now).toBeGreaterThan(bounds.now + 240000);
      expect(result.status, result.text).toBe(201);
      const decision = (await ownerMessages(base, alice, green.caseId)).find(m => m.kind === 'humanDecision');
      expect(decision.outcome).toBe('declined'); return { workId: decision.id, caseId: green.caseId };
    }
  };
  const ordered = await g.conductor.claimOrder.call(c, 'testowner', [green, file]);
  expect(ordered.map(x => x.id)).toEqual(fileFirst ? [file.id, green.id] : [green.id, file.id]);
  async function resumeNoAction(binding) {
    const before = await snapshot(base, alice, green.caseId); let minted, ended, completion;
    let saved = { ...alice, agentId: alice.agent.id, inboxId: alice.inbox.id, address: alice.agent.address };
    const fetcher: typeof fetch = async (input, init) => {
      expect(new URL(String(input)).origin).toBe(base);
      const response = await fetch(input, init), route = new URL(String(input)).pathname;
      if (route.endsWith('/session')) minted = (await response.clone().json()).session;
      if (route.endsWith('/session/end')) ended = await response.clone().text();
      if (route.endsWith('/complete')) completion = await response.clone().json();
      return response;
    };
    const connector = new EnvoiConnector(base, { load: async () => saved, save: async s => { saved = s as any; }, admit: async () => {}, commitCursor: async () => {} } as any,
      { fetch: fetcher, caseSessionHandler: { admit: async message => { expect(message.id).toBe(binding.workId); }, process: async channel => {
        const response = await channel.forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'envoi_case_snapshot', arguments: {} } }));
        const body = await response.json(), shown = JSON.parse(body.result.content[0].text).result;
        expect(shown.requestedResponse.intent).toBe('decline');
        // Provider inference is replaced by a completed no-action boundary.
        apiGlue.terminalResponses('{"status":"completed","output":[]}');
      } } });
    // processWorkOnce owns its renewal/channel cleanup and starts no watch loop.
    expect(await connector.processWorkOnce()).toBe(true);
    const after = await snapshot(base, alice, green.caseId);
    expect(after.record.case.state).toBe('inProgress');
    apiGlue.verifyNoActionCanonicalChange(before, after, binding.workId, completion);
    const mutated = structuredClone(after); mutated.record.case.state = 'completed';
    expect(() => apiGlue.verifyNoActionCanonicalChange(before, mutated, binding.workId, completion)).toThrow('NO_ACTION_CASE_CHANGED');
    const nativeEnd = { session: minted, sessionEndRawBytes: ended };
    expect(JSON.parse(ended).session.workId).toBeUndefined();
    const oldFinal = glue({ finalization: selected.segments.finalization.source.replace('assert.equal(nativeEnd.session?.workId,decisionWorkId)', 'assert.equal(nativeSession.workId,decisionWorkId)') });
    expect(() => oldFinal.finalization(nativeEnd, binding.workId)).toThrow();
    expect(apiGlue.finalization(nativeEnd, binding.workId).status).toBe('ended');
    expect(() => apiGlue.finalization({ ...nativeEnd, session: { ...minted, workId: 'msg_foreign' } }, binding.workId)).toThrow();
    return binding;
  }
  const fixture = { current: async () => ({ operator: { observeNativeHumanAndOriginalEnd: async () => {} }, hooks: { runAndCaptureControl: async ({ workId }) => {
    await advance(Math.max(1, bounds.expiry - now + 1));
    const work = (await claim(base, alice.agentApiToken)).payload.work; expect(work.workId).toBe(workId);
    const session = await mint(base, alice, work), shown = await okTool(base, session, 'envoi_case_snapshot');
    expiryStart = transport.length;
    const refusal = await tool(base, session, 'envoi_case_decide', { proposalRef: shown.proposal.ref, optionRef: shown.proposal.options[0].ref,
      authorityRef: shown.authority.lastPolicyDecision.authorityRef, decision: 'accept', text: 'Must refuse expired authority', idempotencyKey: 'expired-probe' });
    expect(refusal.ok).toBe(false); expect(refusal.code).toBe('AUTHORITY_EXPIRED');
    const failed = await api(base, `/api/agent/work/${workId}/fail`, { token: alice.agentApiToken, body: { leaseToken: work.leaseToken, retryable: true, reasonCode: 'HANDLER_FAILED' } });
    expect(failed.status).toBe(200);
    const immediate = await claim(base, alice.agentApiToken); expect(immediate.payload.work).toBeNull(); expect(immediate.payload.nextAvailableInMs).toBeGreaterThan(0);
    // An immediate claim (v3) cannot supply the requested work. No fallback send,
    // privileged decide or replacement request is attempted after the refusal.
    expect(() => expect(immediate.payload.work?.workId).toBe(workId)).toThrow(); trace.push('refused-and-delayed');
  } } }) };
  if (oldFifo) {
    await expect(g.decisionSequence(c, fixture)).rejects.toThrow('actual canonical FIFO');
    expect(trace).not.toContain('resume');
    return;
  }
  if (oldExpiry) {
    await expect(g.decisionSequence(c, fixture)).rejects.toThrow('C08_DECLINE_EXPIRED_BEFORE_REVIEW');
    expect(trace).not.toContain('resume');
    return;
  }
  await g.decisionSequence(c, fixture);
  const afterExpiry = transport.slice(expiryStart);
  expect(afterExpiry.filter(x => x.tool === 'envoi_case_decide')).toEqual([{ path: '/mcp', method: 'POST', tool: 'envoi_case_decide', scoped: true }]);
  expect(afterExpiry.filter(x => x.method !== 'GET' && (x.path.endsWith('/policy-evaluations') || x.path.endsWith('/messages') || x.path.endsWith('/actions')))).toEqual([]);
  expect(trace.indexOf('resume')).toBeGreaterThan(trace.indexOf('refused-and-delayed'));
  expect(trace.filter(x => ['accept-authority', 'asset-decline'].includes(x))).toEqual(fileFirst ? ['asset-decline', 'accept-authority'] : ['accept-authority', 'asset-decline']);
  // Original scope is stale after original settlement, independent of authority.
  const stale = await api(base, '/mcp', { token: originalSession.token, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(stale.status).toBe(401); expect(stale.payload.code).toBe('CASE_SESSION_ENDED');
  expect(originalWork.workId).toBe(green.id);
}, 60000);
