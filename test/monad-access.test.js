import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonadAccess } from '../src/monad-access.js';

const fixture = ({ available = true, paidOrganizationIds = 'paid_org' } = {}) => {
  const records = new Map([['inboxes/inbox_1/inbox.json', { id: 'inbox_1', organizationId: 'paid_org' }]]);
  const store = { getJson: async key => records.get(key.replaceAll('\\', '/')) || null, putJson: async (key, value) => records.set(key.replaceAll('\\', '/'), value), now: () => '2026-10-25T00:00:00.000Z' };
  return { access: createMonadAccess({ store, available, paidOrganizationIds }), inbox: records.get('inboxes/inbox_1/inbox.json') };
};

test('paid Monad access starts off, toggles on, and toggles off', async () => {
  const { access, inbox } = fixture();
  assert.deepEqual(await access.status(inbox), { available: true, entitled: true, enabled: false });
  assert.equal(await access.active(inbox.id), false);
  assert.equal((await access.set(inbox, true)).enabled, true);
  assert.equal(await access.active(inbox.id), true);
  assert.equal((await access.set(inbox, false)).enabled, false);
  assert.equal(await access.active(inbox.id), false);
});

test('an unentitled organization cannot enable Monad', async () => {
  const { access, inbox } = fixture({ paidOrganizationIds: '' });
  await assert.rejects(access.set(inbox, true), { code: 'MONAD_ENTITLEMENT_REQUIRED' });
  assert.equal(await access.active(inbox.id), false);
});

test('removing an organization entitlement disables an existing opt-in', async () => {
  const { access, inbox } = fixture();
  await access.set(inbox, true);
  inbox.organizationId = 'unentitled_org';
  assert.deepEqual(await access.status(inbox), { available: true, entitled: false, enabled: false });
  assert.equal(await access.active(inbox.id), false);
});

test('a deployment without an issuer cannot enable Monad', async () => {
  const { access, inbox } = fixture({ available: false });
  await assert.rejects(access.set(inbox, true), { code: 'MONAD_UNAVAILABLE' });
  assert.equal(await access.active(inbox.id), false);
});
