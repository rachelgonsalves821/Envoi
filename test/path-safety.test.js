import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FileStore } from '../src/storage.js';
import { assertSafeIdentifier, assertSafeRequestTarget, normalizeDocumentPath } from '../src/path-safety.js';

test('document stores reject traversal, absolute paths, controls, and overlong identifiers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  for (const candidate of ['../escape.json', '..\\escape.json', '/absolute.json', 'C:\\absolute.json', 'safe/../escape.json', `safe/${'x'.repeat(256)}.json`, 'safe/\u0000.json']) {
    assert.throws(() => store.file(candidate), /path/i);
    assert.throws(() => normalizeDocumentPath(candidate), /path/i);
  }
  assert.throws(() => store.file('inboxes', '../escape'), /path/i);
  for (const candidate of ['../agent', 'agent/name', 'agent\\name', 'agent\u0000name', 'x'.repeat(129)]) assert.throws(() => assertSafeIdentifier(candidate), /invalid/);
});

test('HTTP request targets reject encoded separators, traversal, malformed escapes, and controls', () => {
  for (const target of ['/api/inboxes/%2e%2e/messages', '/api/inboxes/a%2Fb/messages', '/api/inboxes/a%5Cb/messages', '/api/inboxes/%ZZ/messages', '/api/inboxes/a%00b/messages']) {
    assert.throws(() => assertSafeRequestTarget(target), /path/i);
  }
  assert.equal(assertSafeRequestTarget('/api/inboxes/inbox_1/messages?limit=10'), true);
});
