import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { api, claim, launch, owner, ownerMessages, send, sleep, waitForMessageStatus } from '../../../test/a3-harness.js';

// HW7 predeclared protocol. Test data only; no hosted calls or model tokens.
const REPEATS = 3;
const DEADLINE_MS = 5000;
const RETRY_BASE_MS = 1200;
const cases = ['ordinary', 'missed_event', 'retry_delay', 'combined_fault'];
const arms = ['event_only', 'startup_poll', 'hint_aware'];
const results = [];
const dataDir = await mkdtemp(new URL('./run-data-', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const server = await launch({ ENVOI_AGENT_WORK_RETRY_BASE_MS: String(RETRY_BASE_MS) }, dataDir);
try {
  const { baseUrl } = server;
  const sender = await owner(baseUrl, '8801');
  const receivers = {
    event_only: await owner(baseUrl, '8802'),
    startup_poll: await owner(baseUrl, '8803'),
    hint_aware: await owner(baseUrl, '8804')
  };
  for (const scenario of cases) for (let repeat = 1; repeat <= REPEATS; repeat += 1) for (const arm of arms) {
    const isMissed = scenario === 'missed_event' || scenario === 'combined_fault';
    const isRetry = scenario === 'retry_delay' || scenario === 'combined_fault';
    const receiver = receivers[arm];
    const caseId = `case_hw7_${scenario}_${repeat}_${arm}`;
    const sent = await send(baseUrl, sender, receiver, { caseId, key: `hw7-${scenario}-${repeat}-${arm}`, text: `Synthetic HW7 ${scenario} ${repeat}` });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(baseUrl, receiver, sent.payload.id, 'delivered');
    const started = performance.now();
    let apiCalls = 0;
    let failedAttempt = false;
    let observedHintMs = null;
    const take = async () => { apiCalls++; return claim(baseUrl, receiver.agentApiToken); };
    const complete = async work => {
      apiCalls++;
      return api(baseUrl, `/api/agent/work/${work.workId}/complete`, { token: receiver.agentApiToken, key: `hw7-complete-${work.workId}`, body: { leaseToken: work.leaseToken } });
    };
    if (!(isMissed && arm === 'event_only')) {
      const first = await take();
      assert.equal(first.status, 200, first.text);
      assert.equal(first.payload.work?.workId, sent.payload.id, first.text);
      if (isRetry) {
        apiCalls++;
        const failed = await api(baseUrl, `/api/agent/work/${sent.payload.id}/fail`, { token: receiver.agentApiToken, body: { leaseToken: first.payload.work.leaseToken, retryable: true, reasonCode: 'synthetic-transient' } });
        assert.equal(failed.status, 200, failed.text);
        failedAttempt = true;
        if (arm !== 'event_only') {
          const idle = await take();
          assert.equal(idle.payload.state, 'idle', idle.text);
          observedHintMs = idle.payload.nextAvailableInMs ?? null;
          if (arm === 'hint_aware') {
            await sleep(Math.max(0, observedHintMs ?? RETRY_BASE_MS) + 40);
            const again = await take();
            assert.equal(again.payload.work?.workId, sent.payload.id, again.text);
            assert.equal((await complete(again.payload.work)).status, 201);
          }
        }
      } else {
        assert.equal((await complete(first.payload.work)).status, 201);
      }
    }
    // A failed policy has no further scheduled action; observe it through the
    // full five-second deadline before scoring the server-owned state.
    if ((isMissed && arm === 'event_only') || (isRetry && arm !== 'hint_aware')) {
      await sleep(Math.max(0, DEADLINE_MS - (performance.now() - started)));
    }
    const elapsedMs = Math.round(performance.now() - started);
    apiCalls++;
    const messages = await ownerMessages(baseUrl, receiver, caseId);
    const status = messages.find(message => message.id === sent.payload.id)?.status;
    const success = status === 'processed' && elapsedMs <= DEADLINE_MS;
    results.push({ scenario, repeat, arm, success, status, elapsedMs, apiCalls, failedAttempt, observedHintMs, messageId: sent.payload.id, caseId });
    console.log(`${scenario} run=${repeat} ${arm}: ${success ? 'PASS' : 'FAIL'} status=${status} time=${elapsedMs}ms calls=${apiCalls} hint=${observedHintMs ?? '-'}`);
    // Clear deliberately unprocessed work before the next case for this receiver.
    if (!success) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const pending = await take();
        if (pending.payload.work?.workId === sent.payload.id) { await complete(pending.payload.work); break; }
        await sleep(Math.max(100, pending.payload.nextAvailableInMs ?? 100));
      }
    }
  }
  const output = { benchmark: 'Envoi HW7 durable-work wake benchmark', sourceCommit: '5b4d7c2941be4052564f12d02c4d5f304af76ffc', setup: { repeats: REPEATS, deadlineMs: DEADLINE_MS, retryBaseMs: RETRY_BASE_MS, backend: 'local FileStore', check: 'server-owned recipient message status processed within deadline' }, results };
  await writeFile(new URL('./results.json', import.meta.url), JSON.stringify(output, null, 2));
} finally {
  await server.stop();
}
