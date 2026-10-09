import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvoiEnvironmentAliases } from '../src/envoi-environment.js';

test('new and existing Envoi environment keys resolve to the same setting', () => {
  assert.deepEqual(applyEnvoiEnvironmentAliases({ ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' }), {
    ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com', SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com'
  });
  assert.deepEqual(applyEnvoiEnvironmentAliases({ SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com' }), {
    ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com', SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com'
  });
});

test('conflicting Envoi environment aliases fail without revealing values', () => {
  const values = { ENVOI_DATA_ENCRYPTION_KEY: 'new-private-value', SINALOA_DATA_ENCRYPTION_KEY: 'old-private-value' };
  assert.throws(() => applyEnvoiEnvironmentAliases(values), error => {
    assert.match(error.message, /Conflicting Envoi environment aliases/);
    assert.equal(error.message.includes('private-value'), false);
    return true;
  });
});
