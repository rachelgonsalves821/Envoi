import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { launch, owner, pauseAgent, send, readData, writeData, deleteData, installOutboxGate, eventually, waitForMessageStatus, outboxParts } from './a3-harness.js';

const sha = 'a'.repeat(40);
const entries = server => server.stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.event?.startsWith('envoi.queue_consumer.') ? [value] : []; } catch { return []; } });

test('real server correlates original lease IDs and private directory rejection reasons without changing public errors', async t => {
  const server = await launch({ ENVOI_RELEASE_SHA: sha });
  assert.ok(path.resolve(server.dataDir).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => server.stop());
  const sender = await owner(server.baseUrl, '9701');
  const recipient = await owner(server.baseUrl, '9702');
  await pauseAgent(server.baseUrl, recipient);
  const parts = ['directory', 'agents', `${recipient.agent.id}.json`];
  const original = await readData(server, ...parts);
  for (const [fault, reason] of [['missing', 'RECIPIENT_DIRECTORY_MISSING'], ['status', 'RECIPIENT_DIRECTORY_STATUS'], ['inbox', 'RECIPIENT_DIRECTORY_INBOX_MISMATCH']]) {
    const caseId = `case_consumer_${fault}`;
    const first = await send(server.baseUrl, sender, recipient, { caseId, text: 'first diagnostic message' });
    assert.equal(first.status, 202);
    await waitForMessageStatus(server.baseUrl, recipient, first.payload.id, 'delivered');
    const gate = await installOutboxGate(server, caseId);
    let second;
    try {
      second = await send(server.baseUrl, sender, recipient, { caseId, text: 'second diagnostic message' });
      assert.equal(second.status, 202);
      if (fault === 'missing') await deleteData(server, ...parts);
      else await writeData(server, parts, { ...original, ...(fault === 'status' ? { status: 'revoked' } : { inboxId: 'inbox_wrong_target' }) });
      await gate.remove();
      const outbox = await eventually(async () => { const value = await readData(server, ...outboxParts(second.payload.id)); return value?.status === 'deadLettered' ? value : null; }, { timeoutMs: 10000 });
      assert.equal(outbox.attempts, 1);
      assert.equal(outbox.lastError, 'Recipient agent is unavailable');
      const rejection = await eventually(() => entries(server).find(entry => entry.event === 'envoi.queue_consumer.rejected' && entry.messageId === second.payload.id));
      assert.equal(rejection.reasonCode, reason);
      assert.equal(rejection.releaseSha, sha);
      assert.equal(rejection.workerId, outbox.lockedBy || entries(server).find(entry => entry.event === 'envoi.queue_consumer.claimed' && entry.messageId === second.payload.id).workerId);
      assert.equal(rejection.backend, 'file');
      assert.equal(rejection.databaseFingerprint, null);
      const start = entries(server).find(entry => entry.event === 'envoi.queue_consumer.started');
      assert.equal(rejection.workerId, start.workerId);
      assert.equal(rejection.instanceTag, start.instanceTag);
      const senderMessage = await readData(server, 'inboxes', sender.inbox.id, 'messages', `${second.payload.id}.json`);
      assert.equal(senderMessage.lastDeliveryError, 'Recipient agent is unavailable');
      assert.equal(senderMessage.recipientAgentId, first.payload.recipientAgentId);
      assert.equal(senderMessage.caseId, first.payload.caseId);
      assert.equal('reasonCode' in senderMessage, false, 'private diagnostics do not change message contracts');
    } catch (error) {
      const snapshot = second?.payload?.id ? await readData(server, ...outboxParts(second.payload.id)) : null;
      const diagnostic = { fault, status: snapshot?.status, attempts: snapshot?.attempts, gateExists: Boolean(await readData(server, 'outbox', `${gate.id}.json`)), observedRejections: entries(server).filter(entry => entry.event === 'envoi.queue_consumer.rejected').map(entry => ({ messageId: entry.messageId, reasonCode: entry.reasonCode })) };
      t.diagnostic(JSON.stringify(diagnostic));
      let stderr = server.stderr.slice(-1500);
      for (const token of [sender.agentApiToken, sender.agentRefreshToken, recipient.agentApiToken, recipient.agentRefreshToken]) stderr = stderr.replaceAll(token, '<redacted>');
      t.diagnostic(stderr);
      throw error;
    } finally { await writeData(server, parts, original); await gate.remove(); }
  }
  const logs = JSON.stringify(entries(server));
  for (const token of [sender.agentApiToken, sender.agentRefreshToken, recipient.agentApiToken, recipient.agentRefreshToken]) assert.ok(!logs.includes(token));
  assert.doesNotMatch(logs, /leaseToken|diagnostic message/);
  assert.equal((await readData(server, 'inboxes', recipient.inbox.id, 'agents', `${recipient.agent.id}.json`)).status, 'paused');
});
