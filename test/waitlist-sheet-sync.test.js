import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createWaitlistSheetSync } from '../src/waitlist-sheet-sync.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  type: 'service_account',
  client_email: 'waitlist@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
});

test('waitlist Sheet sync backfills once and keeps email cells as raw data', async () => {
  const rows = [];
  const appended = [];
  let createdTab = false;
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    assert.equal(options.headers.authorization, 'Bearer test-token');
    if (url.includes('?fields=')) return Response.json({ sheets: [
      { properties: { sheetId: 0, title: 'Sheet1' } },
      ...(createdTab ? [{ properties: { sheetId: 1, title: 'Envoi Waitlist' } }] : [])
    ] });
    if (url.endsWith(':batchUpdate')) {
      assert.equal(JSON.parse(options.body).requests[0].addSheet.properties.title, 'Envoi Waitlist');
      createdTab = true;
      return Response.json({ replies: [{ addSheet: { properties: { sheetId: 1, title: 'Envoi Waitlist' } } }] });
    }
    assert.match(url, /Envoi%20Waitlist/);
    if (options.method === 'PUT') {
      rows.push(...JSON.parse(options.body).values);
      return Response.json({ updatedRows: 1 });
    }
    if (options.method === 'POST') {
      const values = JSON.parse(options.body).values;
      rows.push(...values);
      appended.push({ url, values });
      return Response.json({ updates: { updatedRows: values.length } });
    }
    return Response.json({ values: rows });
  };
  const store = { withTransaction: async (_keys, operation) => operation(), listJson: async () => [
    { email: 'rachel@example.com', createdAt: '2026-10-03T12:00:00.000Z', source: 'landing' },
    { email: '=formula@example.com', createdAt: '2026-10-03T12:01:00.000Z', source: 'landing' }
  ] };
  const sync = createWaitlistSheetSync({ store, sheetId: 'test-sheet', serviceAccountJson, fetchImpl });
  assert.equal(await sync.run(), 2);
  assert.deepEqual(rows[0], ['email', 'joined_at', 'source']);
  assert.deepEqual(rows[1], ['rachel@example.com', '2026-10-03T12:00:00.000Z', 'landing']);
  assert.equal(appended[0].values[1][0], '=formula@example.com');
  assert.match(appended[0].url, /valueInputOption=RAW/);
  assert.equal(await sync.run(), 0);
  assert.equal(createdTab, true);
  assert.equal(appended.length, 1);
});

test('waitlist Sheet sync rejects unexpected headers without changing the Sheet', async () => {
  let writeCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-token' });
    if (url.includes('?fields=')) return Response.json({ sheets: [{ properties: { sheetId: 1, title: 'Envoi Waitlist' } }] });
    if (options.method) writeCount += 1;
    return Response.json({ values: [['private notes']] });
  };
  const sync = createWaitlistSheetSync({
    store: { withTransaction: async (_keys, operation) => operation(), listJson: async () => [{ email: 'rachel@example.com' }] },
    sheetId: 'test-sheet', serviceAccountJson, fetchImpl
  });
  await assert.rejects(sync.run(), /header must be/);
  assert.equal(writeCount, 0);
});

test('waitlist Sheet sync leaves stored signups intact when Google is unavailable', async () => {
  const entries = [{ email: 'rachel@example.com' }];
  const sync = createWaitlistSheetSync({
    store: { withTransaction: async (_keys, operation) => operation(), listJson: async () => entries }, sheetId: 'test-sheet', serviceAccountJson,
    fetchImpl: async () => new Response('', { status: 503 })
  });
  await assert.rejects(sync.run(), /503/);
  assert.deepEqual(entries, [{ email: 'rachel@example.com' }]);
});
