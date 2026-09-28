import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations } from '../src/migrations.js';

test('checked-in migrations are ordered, immutable, and cover production tables', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(migration => migration.name), ['001_documents.sql', '002_object_storage.sql', '003_delivery.sql']);
  assert.ok(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum)));
  const schema = migrations.map(migration => migration.sql).join('\n');
  for (const table of ['sinaloa_documents', 'sinaloa_object_quota_usage', 'sinaloa_object_quota_reservations', 'sinaloa_event_sequences', 'sinaloa_outbox']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});
