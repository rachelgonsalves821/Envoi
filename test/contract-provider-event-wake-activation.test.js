// provider-event-wake-activation v1 (handoffs.md): every case follows the §1 rule, and the handoff lists the fixtures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const index = await readJson(path.join(root, 'index.json'));
const contract = index.contracts.find((entry) => entry.id === 'provider-event-wake-activation');
const fixtures = await Promise.all(contract.fixtures.map((name) => readJson(path.join(root, contract.dir, name))));
const parent = await readJson(path.join(root, 'provider-event-wake', 'schemas.json'));

// §1: the reference rule.
const expectedQueue = ({ existing, catchUp }) => {
  if (existing === 'active') return [];
  return catchUp.length ? catchUp : [{ name: 'envoi.work_available', reason: 'subscription_activated' }];
};

test('provider-event-wake-activation: every subscribe case follows the §1 rule', () => {
  for (const fixture of fixtures.filter((entry) => entry.kind === 'subscribe')) {
    assert.deepEqual(fixture.effects.queued, expectedQueue(fixture.context), fixture.id);
    assert.equal(fixture.request.body.params.name, 'envoi.work_available', fixture.id);
  }
  const rows = new Set(fixtures.filter((entry) => entry.kind === 'subscribe').map((entry) => `${entry.context.existing}/${entry.context.catchUp.length > 0}`));
  for (const row of ['null/false', 'null/true', 'active/false', 'ended/false']) assert.ok(rows.has(row), `a case covers ${row}`);
});

test('provider-event-wake-activation: subscription_activated is an existing provider-event-wake reason, delivered as an ordinary event', () => {
  const work = parent['x-events'].find((event) => event.name === 'envoi.work_available');
  assert.ok(work.payloadSchema.properties.reason.enum.includes('subscription_activated'));
  const delivery = fixtures.find((entry) => entry.kind === 'delivery');
  const body = JSON.parse(delivery.delivery.bodyText);
  assert.deepEqual(Object.keys(body).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
  assert.deepEqual([body.name, body.data.reason], ['envoi.work_available', 'subscription_activated']);
  assert.ok(delivery.delivery.responseStatus >= 200 && delivery.delivery.responseStatus < 300);
  assert.match(delivery.effects.backgroundReceivingAfter.lastAlertAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('provider-event-wake-activation: the handoff lists exactly the registered fixtures', async () => {
  const handoffs = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
  const section = handoffs.split('\n## ').find((part) => part.startsWith('provider-event-wake-activation v1'));
  assert.ok(section, 'handoffs.md has the section');
  const listed = [...new Set([...section.matchAll(/`([a-z-]+\.json)`/g)].map((match) => match[1]))].filter((name) => name !== 'schemas.json').sort();
  assert.deepEqual(listed, [...contract.fixtures].sort());
});
