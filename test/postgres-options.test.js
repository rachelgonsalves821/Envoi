import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresOptions } from '../src/postgres-options.js';

test('production PostgreSQL requires certificate-verified TLS', () => {
  assert.throws(() => createPostgresOptions('postgresql://user:secret@db.example/sinaloa', {
    SINALOA_AUTH_MODE: 'production', SINALOA_DB_SSL_MODE: 'disable'
  }), /verify-full/);
  const options = createPostgresOptions('postgresql://user:secret@db.example/sinaloa', {
    SINALOA_AUTH_MODE: 'production', SINALOA_DB_SSL_MODE: 'verify-full', SINALOA_DB_CA: 'test-ca'
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'test-ca' });
});

test('PostgreSQL reads ENVOI-prefixed TLS settings', () => {
  const options = createPostgresOptions('postgresql://user:secret@db.example/envoi', {
    ENVOI_AUTH_MODE: 'production', ENVOI_DB_SSL_MODE: 'verify-full', ENVOI_DB_CA: 'test-ca'
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'test-ca' });
});

test('PostgreSQL options reject URL-level TLS overrides and invalid timeouts', () => {
  assert.throws(() => createPostgresOptions('postgresql://db.example/sinaloa?sslmode=require', {}), /not DATABASE_URL query parameters/);
  assert.throws(() => createPostgresOptions('postgresql://db.example/sinaloa', { SINALOA_DB_POOL_SIZE: 'NaN' }), /positive integer/);
  assert.throws(() => createPostgresOptions('postgresql://db.example/sinaloa', { SINALOA_DB_QUERY_TIMEOUT_MS: '0' }), /positive integer/);
});
