import { expect, it } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { QuickConnectHandoffError } from '../../sdk/typescript/src/quick-connect';
import { ConnectorSetupError } from './adapter';
import { connectorErrorMessage, connectorFailureMessage } from './error';
it('shows the required update instruction without leaking a remote body', () => {
  expect(connectorErrorMessage(new EnvoiError('private remote body', 400, 'ROTATION_ID_REQUIRED'))).toBe('ROTATION_ID_REQUIRED: update your connector');
});

it('links a setup code to the Envoi site used for setup', () => {
  const error = new ConnectorSetupError('GATEWAY_UNREACHABLE', 'Check your Gateway');
  expect(connectorFailureMessage(error, 'https://staging.envoi.example/')).toBe(
    'GATEWAY_UNREACHABLE: Check your Gateway\nFix: https://staging.envoi.example/docs/fix/#GATEWAY_UNREACHABLE'
  );
});

it.each([undefined, 'https://user:secret@envoi.example', 'https://envoi.example/?code=secret', 'http://envoi.example'])(
  'uses the public docs when no safe Envoi origin is available (%s)', apiUrl => {
    const error = new QuickConnectHandoffError('Invalid Envoi setup file');
    expect(connectorFailureMessage(error, apiUrl)).toBe(
      'Invalid Envoi setup file\nFix: https://www.envoi-agents.com/docs/fix/#HANDOFF_INVALID'
    );
  }
);
it('reports replacement guidance and keeps unknown provider failures private', () => {
  expect(connectorErrorMessage(new EnvoiError('private token', 401, 'CREDENTIAL_REVOKED', { reason: 'replaced' }))).toContain('replaced by a reconnect');
  expect(connectorErrorMessage(new Error('private provider token'))).not.toContain('private provider token');
});
