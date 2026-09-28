import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfiguration } from '../src/production-config.js';

const validProduction = (overrides = {}) => ({
  SINALOA_AUTH_MODE: 'production',
  SINALOA_PUBLIC_URL: 'https://app.sinaloa.example',
  DATABASE_URL: 'postgresql://user:secret@db.example/sinaloa',
  SINALOA_HUMAN_AUTH_PROVIDER: 'workos',
  WORKOS_CLIENT_ID: 'client_123',
  WORKOS_API_KEY: 'sk_live_123',
  WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
  WORKOS_REDIRECT_URI: 'https://app.sinaloa.example/api/auth/workos/callback',
  SINALOA_DATA_ENCRYPTION_KEY: 'b'.repeat(32),
  SINALOA_COOKIE_SECURE: 'true',
  SINALOA_COOKIE_SAMESITE: 'Lax',
  SINALOA_CORS_ORIGIN: 'https://app.sinaloa.example',
  SINALOA_AGENT_DOMAIN: 'agents.sinaloa.example',
  SINALOA_OBJECT_STORAGE_PROVIDER: 's3',
  SINALOA_S3_ENDPOINT: 'https://s3.ca-central-1.amazonaws.com',
  SINALOA_S3_BUCKET: 'sinaloa-private',
  SINALOA_S3_REGION: 'ca-central-1',
  SINALOA_S3_ACCESS_KEY_ID: 'access',
  SINALOA_S3_SECRET_ACCESS_KEY: 'secret',
  SINALOA_MALWARE_SCANNER_URL: 'https://scanner.sinaloa.example/scan',
  SINALOA_ENABLE_EXTERNAL_EMAIL: 'false',
  ...overrides
});

test('development configuration remains local while production fails unsafe dependencies closed', () => {
  assert.deepEqual(validateProductionConfiguration({ SINALOA_AUTH_MODE: 'development' }), { mode: 'development', validated: false });
  assert.throws(() => validateProductionConfiguration(validProduction({ DATABASE_URL: '', SINALOA_OBJECT_STORAGE_PROVIDER: 'local', SINALOA_AGENT_DOMAIN: 'sinaloa.mail' })), /DATABASE_URL is required[\s\S]*must be s3[\s\S]*cannot use \.mail/);
});

test('production supports native platform routing without SMTP and conditionally validates public email', () => {
  const nativeOnly = validateProductionConfiguration(validProduction());
  assert.equal(nativeOnly.validated, true);
  assert.equal(nativeOnly.externalEmailEnabled, false);
  assert.equal(nativeOnly.emailDomain, null);

  assert.throws(() => validateProductionConfiguration(validProduction({ SINALOA_ENABLE_EXTERNAL_EMAIL: 'true' })), /SINALOA_EMAIL_PROVIDER must be resend[\s\S]*RESEND_API_KEY is required/);

  const dualTransport = validateProductionConfiguration(validProduction({
    SINALOA_ENABLE_EXTERNAL_EMAIL: 'true',
    SINALOA_EMAIL_PROVIDER: 'resend',
    SINALOA_PUBLIC_EMAIL_DOMAIN: 'mail.sinaloa.example',
    SINALOA_EMAIL_DOMAIN_VERIFIED: 'true',
    RESEND_API_KEY: 're_live_123',
    RESEND_WEBHOOK_SECRET: 'whsec_123'
  }));
  assert.equal(dualTransport.externalEmailEnabled, true);
  assert.equal(dualTransport.emailDomain, 'mail.sinaloa.example');
});
