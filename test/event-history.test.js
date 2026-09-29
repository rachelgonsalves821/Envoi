import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEventPage, persistedEventCursor } from '../src/event-history.js';

test('forward replay pages drain without repeating or skipping the boundary event', async () => {
  const events = [1, 2, 3, 4, 5].map(sequence => ({ id: `evt_${sequence}`, sequence, cursor: String(sequence).padStart(20, '0') }));
  const calls = [];
  const store = { async queryJson(dir, options) {
    calls.push(options);
    return events.filter(event => !options.after || event.cursor > options.after.value || (event.cursor === options.after.value && event.id > options.after.id)).slice(0, options.limit);
  } };
  let cursor = ''; const seen = []; let page;
  do { page = await fetchEventPage(store, 'inbox', { cursor, limit: 1 }); seen.push(...page.events.map(event => event.id)); cursor = page.nextCursor; } while (page.hasMore);
  assert.deepEqual(seen, events.map(event => event.id));
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.order === 'asc' && call.sortField === 'cursor' && call.limit === 2));
  assert.deepEqual(await fetchEventPage(store, 'inbox', { cursor }), { events: [], nextCursor: cursor, hasMore: false });
});

test('legacy cursor fallback is explicit and missing persisted cursors require migration', async () => {
  assert.equal(persistedEventCursor({ sequence: 12 }), '00000000000000000012');
  assert.equal(persistedEventCursor({ createdAt: '2026-01-01', id: 'evt_old' }), '2026-01-01|evt_old');
  await assert.rejects(fetchEventPage({ queryJson: async () => [{ id: 'evt_old', sequence: 1 }] }, 'inbox'), error => error.statusCode === 503);
});

test('event bounds reject invalid input before storage access', async () => {
  const store = { queryJson() { assert.fail('must validate first'); } };
  for (const limit of [0, 1.2, NaN, Infinity, 201]) await assert.rejects(fetchEventPage(store, 'inbox', { limit }), error => error.statusCode === 400);
  await assert.rejects(fetchEventPage(store, 'inbox', { cursor: 'bad\nvalue' }), error => error.statusCode === 400);
});
