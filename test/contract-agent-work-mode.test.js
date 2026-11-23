// agent-work-mode v1 (handoffs.md): each case follows the rules of §2–§5, and the handoff lists the fixtures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const index = await readJson(path.join(root, 'index.json'));
const contract = index.contracts.find((entry) => entry.id === 'agent-work-mode');
const fixtures = await Promise.all(contract.fixtures.map((name) => readJson(path.join(root, contract.dir, name))));
const schemas = await readJson(path.join(root, contract.dir, contract.schemas));
const isInstruction = (work) => ['humanInstruction', 'humanDecision'].includes(work?.message?.kind);

test('agent-work-mode: setting a mode returns it, and off ends exactly the Dot\'s live MCP Events subscriptions (§2, §3)', () => {
  for (const fixture of fixtures.filter((entry) => entry.request.method === 'PUT' && entry.response.status === 200)) {
    assert.equal(fixture.response.body.workMode.mode, fixture.request.body.mode, fixture.id);
    assert.ok(fixture.response.body.workMode.updatedAt, `${fixture.id}: a chosen mode has updatedAt`);
    assert.deepEqual(fixture.effects.audit[0], 'agent.work_mode_changed', fixture.id);
    if (fixture.request.body.mode !== 'off') continue;
    const expected = fixture.context.deliveryMode === 'on_demand'
      ? (fixture.context.subscriptionsBefore || []).filter((sub) => sub.profile === 'mcp_events' && ['active', 'pending'].includes(sub.status)).map((sub) => ({ id: sub.id, endedReason: 'ended_by_owner' }))
      : [];
    assert.deepEqual(fixture.effects.endedSubscriptions, expected, `${fixture.id}: ended subscriptions`);
  }
});

test('agent-work-mode: refusals use their x-codes rows, and the flag hides the route (§2, §7)', () => {
  for (const fixture of fixtures.filter((entry) => entry.response.status >= 400)) {
    const entry = schemas['x-codes'][fixture.response.body.code];
    assert.ok(entry, `${fixture.id}: known code`);
    assert.equal(fixture.response.status, entry.status, fixture.id);
  }
  assert.equal(fixtures.find((entry) => entry.id === 'mode-flag-off').flags.ENVOI_WORK_MODE, false);
});

test('agent-work-mode: reads default to routine and carry workMode (§4)', () => {
  const info = (id) => JSON.parse(fixtures.find((entry) => entry.id === id).response.body.result.content[0].text);
  assert.deepEqual(info('agent-info-default').workMode, { mode: 'routine', updatedAt: null });
  assert.equal(info('agent-info-work-mode').workMode.mode, 'ask');
  assert.equal(fixtures.find((entry) => entry.id === 'agent-status-work-mode').response.body.workMode.mode, 'ask');
});

test('agent-work-mode: subscribe is refused exactly while off (§4)', () => {
  const rpc = schemas['x-rpc-errors'].BackgroundReceivingOff;
  for (const fixture of fixtures.filter((entry) => entry.request.body?.method === 'events/subscribe')) {
    if (fixture.context.modeBefore === 'off') assert.deepEqual(fixture.response.body.error, { code: rpc.code, message: rpc.message, data: rpc.data }, fixture.id);
    else assert.ok(fixture.response.body.result?.id, `${fixture.id}: subscribe proceeds`);
  }
});

test('agent-work-mode: off hides peer work from connector claims only (§5)', () => {
  for (const fixture of fixtures.filter((entry) => entry.request.path === '/api/agent/work/claim')) {
    const { deliveryMode, modeBefore, claimable } = fixture.context;
    const { work } = fixture.response.body;
    if (deliveryMode === 'on_demand' || modeBefore !== 'off') { assert.ok(work, `${fixture.id}: claims are unchanged`); continue; }
    if (claimable.includes('instruction')) assert.ok(isInstruction(work), `${fixture.id}: owner instructions are still offered`);
    else assert.deepEqual(fixture.response.body, { work: null, state: 'idle' }, `${fixture.id}: peer work is hidden as an ordinary idle claim`);
  }
});

test('agent-work-mode: the handoff lists exactly the registered fixtures', async () => {
  const handoffs = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
  const section = handoffs.split('\n## ').find((part) => part.startsWith('agent-work-mode v1'));
  assert.ok(section, 'handoffs.md has the section');
  const listed = [...new Set([...section.matchAll(/`([a-z-]+\.json)`/g)].map((match) => match[1]))].filter((name) => name !== 'schemas.json').sort();
  assert.deepEqual(listed, [...contract.fixtures].sort());
});
