// agent-listening-status v1 (handoffs.md): each fixture's backgroundReceiving follows from its stored context by §3 and §4.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const index = await readJson(path.join(root, 'index.json'));
const contract = index.contracts.find((entry) => entry.id === 'agent-listening-status');
const dir = path.join(root, contract.dir);
const schemas = await readJson(path.join(dir, contract.schemas));
const fixtures = await Promise.all(contract.fixtures.map((name) => readJson(path.join(dir, name))));
const cap = schemas['x-limits'].waitingCountCap;

const newest = (list, field) => [...list].sort((a, b) => String(b[field]).localeCompare(String(a[field])))[0];

// §3: the reference derivation. The server implementation must agree with it on every fixture.
function derive({ deliveryMode, wakeAvailable, subscriptions, claimable }) {
  const waiting = claimable.count === 0 ? { count: 0, more: false, oldestAt: null }
    : { count: Math.min(claimable.count, cap), more: claimable.count > cap, oldestAt: claimable.oldestAt };
  const base = { since: null, lastAlertAt: null, endedReason: null, waiting };
  if (deliveryMode !== 'on_demand') return { state: 'connector', ...base };
  if (!wakeAvailable) return { state: 'unavailable', ...base };
  const active = subscriptions.filter((sub) => sub.status === 'active');
  const healthy = active.filter((sub) => sub.delivery?.state !== 'failing');
  if (active.length) {
    const current = newest(healthy.length ? healthy : active, 'activatedAt');
    return { ...base, state: healthy.length ? 'on' : 'failing', since: current.activatedAt, lastAlertAt: current.delivery?.lastSuccessAt ?? null };
  }
  const pending = subscriptions.filter((sub) => sub.status === 'pending');
  if (pending.length) return { ...base, state: 'starting', since: newest(pending, 'createdAt').createdAt };
  const ended = subscriptions.filter((sub) => sub.status === 'ended');
  if (!ended.length) return { state: 'off', ...base };
  const last = newest(ended, 'endedAt');
  return { ...base, state: 'off', since: last.endedAt, endedReason: last.endedReason, lastAlertAt: last.delivery?.lastSuccessAt ?? null };
}

const observed = (fixture) => {
  if (fixture.response.toolResult) return JSON.parse(fixture.response.body.result.content[0].text).backgroundReceiving;
  return fixture.response.body[0].backgroundReceiving;
};

test('agent-listening-status: every fixture follows the §3 derivation', () => {
  for (const fixture of fixtures) {
    const value = observed(fixture);
    if (fixture.context.scopedCaseId) {
      assert.equal(value, undefined, `${fixture.id}: case-scoped reads carry no backgroundReceiving`);
      continue;
    }
    assert.deepEqual(value, derive(fixture.context), fixture.id);
  }
});

test('agent-listening-status: owner banners follow x-owner-banner', () => {
  const rows = schemas['x-owner-banner'].rows;
  for (const fixture of fixtures.filter((entry) => entry.client.surface === 'owner_ui')) {
    const { state, endedReason, waiting, since } = observed(fixture);
    const connectionState = fixture.response.body[0].connection.state;
    const age = since ? (Date.parse(fixture.context.now) - Date.parse(since)) / 1000 : 0;
    const row = waiting.count === 0 ? null : rows.find((entry) => entry.state === state
      && (entry.endedReason === '*' ? endedReason !== null : entry.endedReason === endedReason)
      && (!entry.connectionStates || entry.connectionStates.includes(connectionState))
      && (entry.minStateSeconds === undefined || age > entry.minStateSeconds));
    assert.equal(Boolean(fixture.client.banner), Boolean(row), `${fixture.id}: banner shown exactly when a row matches`);
    if (!row) continue;
    assert.equal(fixture.client.banner.docs, row.docs, `${fixture.id}: docs link`);
    assert.equal(fixture.client.banner.action, row.action, `${fixture.id}: action`);
    assert.ok(schemas['x-owner-banner'].actions[row.action], `${fixture.id}: ${row.action} is defined`);
    assert.equal('copyText' in fixture.client.banner, row.action === 'restart_connector', `${fixture.id}: copyText exactly for restart_connector`);
  }
});

test('agent-listening-status: every banner row and action is exercised by a fixture', () => {
  const { rows, actions } = schemas['x-owner-banner'];
  const used = fixtures.map((fixture) => fixture.client.banner).filter(Boolean);
  for (const row of rows.filter((entry) => entry.endedReason !== '*')) assert.ok(used.some((banner) => banner.docs === row.docs && banner.action === row.action && banner.title === row.title.replace('{name}', 'Mark')), `a fixture shows the ${row.state}/${row.connectionStates || row.endedReason} row`);
  for (const action of Object.keys(actions).filter((name) => rows.some((row) => row.action === name))) assert.ok(used.some((banner) => banner.action === action), `a fixture uses ${action}`);
});

test('agent-listening-status: the handoff lists exactly the registered fixtures', async () => {
  const handoffs = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
  const section = handoffs.split('\n## ').find((part) => part.startsWith('agent-listening-status v1'));
  assert.ok(section, 'handoffs.md has the agent-listening-status v1 section');
  const listed = [...new Set([...section.matchAll(/`([a-z-]+\.json)`/g)].map((match) => match[1]))].filter((name) => name !== 'schemas.json').sort();
  assert.deepEqual(listed, [...contract.fixtures].sort());
});
