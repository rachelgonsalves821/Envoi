import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHistory, parseHistoryCursors, decodeHistoryCursor } from '../src/workspace-history.js';
import { publicHttpError } from '../src/http-security.js';

test('history bounds every collection and uses an exclusive composite cursor', async () => {
  const calls = [];
  const store = {
    async queryJson(dir, options) { calls.push(options); return ['c', 'b', 'a'].map(id => ({ id, createdAt: 'same', updatedAt: 'same' })); },
    async countJson() { return 123; }
  };
  const page = await workspaceHistory(store, 'inbox', {}, 2);
  assert.equal(calls.length, 7);
  for (const [key, rows] of Object.entries(page.items)) {
    assert.equal(rows.length, 2);
    assert.equal(page.history[key].total, 123);
    assert.deepEqual(decodeHistoryCursor(page.history[key].nextCursor), { value: 'same', id: 'b' });
  }
  const cursors = parseHistoryCursors(JSON.stringify({ cases: page.history.cases.nextCursor }));
  await workspaceHistory(store, 'inbox', cursors, 2);
  assert.deepEqual(calls[7].before, { value: 'same', id: 'b' });
});

test('malformed cursors and invalid page sizes map to HTTP 400', async () => {
  for (const parse of [() => parseHistoryCursors('{"cases":"invalid"}'), () => decodeHistoryCursor('invalid')]) {
    try { parse(); assert.fail('must reject'); }
    catch (error) { assert.equal(publicHttpError(error).status, 400); }
  }
  const store = { queryJson: async () => [], countJson: async () => 0 };
  for (const limit of [1.5, NaN, Infinity, 'abc', 0, -1, 101, null, '']) {
    await assert.rejects(workspaceHistory(store, 'inbox', {}, limit), error => publicHttpError(error).status === 400);
  }
  assert.equal((await workspaceHistory(store, 'inbox', {}, '10')).history.cases.total, 0);
});

test('corrupt records cannot produce non-advancing cursors', async () => {
  await assert.rejects(workspaceHistory({ queryJson: async () => [{ createdAt: 'today' }], countJson: async () => 1 }, 'inbox'), /stable ID/);
});

test('empty or exhausted pages have no continuation and malformed cursors fail', async () => {
  const page = await workspaceHistory({ queryJson: async () => [], countJson: async () => 0 }, 'inbox');
  assert.deepEqual(page.history.cases, { total: 0, nextCursor: null, hasMore: false });
  for (const raw of ['[]', '{"unknown":"x"}', '{"cases":"invalid"}', '{"cases":12}']) assert.throws(() => parseHistoryCursors(raw), /Invalid history cursor/);
});
