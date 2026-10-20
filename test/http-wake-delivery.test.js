// http-wake v1: a delivered native message wakes the recipient's active subscription, and the wake
// is queued only after the delivery committed. FileStore only: the subscription is seeded on disk,
// because a real challenge needs a public HTTPS receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dataFile, eventually, launch, owner, readData, send, waitForMessageStatus, writeData } from './a3-harness.js';

const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const enabled = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: JSON.stringify([{ kid: 'delivery-tests', privateKey: key, activeFrom: '2026-01-01T00:00:00.000Z' }]) };

async function queuedWakes(server, subscriptionId) {
  let names = [];
  try { names = await readdir(dataFile(server, 'http-wake', 'queue')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readData(server, 'http-wake', 'queue', name).catch(() => null)));
  return records.filter(record => record?.subscriptionId === subscriptionId);
}

test('[FileStore] a delivered native message queues the recipient wake after the delivery commits', { timeout: 60000 }, async t => {
  const server = await launch(enabled); t.after(() => server.stop());
  const alice = await owner(server.baseUrl, '9600'), bob = await owner(server.baseUrl, '9601');
  const [familyFile] = await readdir(dataFile(server, 'auth', 'agent-credential-families', bob.inbox.id, bob.agent.id));
  const at = new Date().toISOString();
  const subscription = { id: 'wake_sub_delivery_test', inboxId: bob.inbox.id, agentId: bob.agent.id, familyId: familyFile.replace(/\.json$/, ''),
    installationId: 'installation_delivery_test', url: 'https://wake.invalid/hook', status: 'active', endedReason: null, endedAt: null,
    createdAt: at, activatedAt: at, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), challengeExpiresAt: null, replacesSubscriptionId: null,
    delivery: { state: 'healthy', lastAttemptAt: null, lastSuccessAt: at, consecutiveFailures: 0, lastFailureClass: null }, challengeHash: null, sequence: 0, dirty: {} };
  // The layout from src/http-wake-paths.js: the record under its agent, plus its status index entry.
  await writeData(server, ['http-wake', 'agents', bob.agent.id, 'wake-subscriptions', `${subscription.id}.json`], subscription);
  await writeData(server, ['http-wake', 'subscription-index', `${subscription.id}.json`],
    { id: subscription.id, inboxId: subscription.inboxId, agentId: subscription.agentId, status: subscription.status, endedAt: null });
  assert.deepEqual(await queuedWakes(server, subscription.id), []);

  const sent = await send(server.baseUrl, alice, bob, { text: 'Wake after commit' });
  assert.equal(sent.status, 202, sent.text);
  const messageId = sent.payload.id || sent.payload.messageId;
  await waitForMessageStatus(server.baseUrl, alice, messageId, 'delivered');
  const wakes = await eventually(async () => {
    const records = (await queuedWakes(server, subscription.id)).filter(record => record.reason === 'message_delivered');
    return records.length ? records : null;
  }, { timeoutMs: 15000, message: 'the delivery queues a message_delivered wake' });
  const delivered = await readData(server, 'inboxes', bob.inbox.id, 'messages', `${messageId}.json`);
  assert.equal(delivered?.status, 'delivered');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, 'wake.work_available');
  assert.ok(wakes[0].createdAt >= delivered.deliveredAt, 'the wake is queued after the delivery committed');
});
