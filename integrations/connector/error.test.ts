import { expect, it } from 'vitest';
import { SinaloaError } from '../../sdk/typescript/src/index';
import { connectorErrorMessage } from './error';
it('shows the required update instruction without leaking a remote body', () => {
  expect(connectorErrorMessage(new SinaloaError('private remote body', 400, 'ROTATION_ID_REQUIRED'))).toBe('ROTATION_ID_REQUIRED: update your connector');
});
it('reports replacement guidance and keeps unknown provider failures private', () => {
  expect(connectorErrorMessage(new SinaloaError('private token', 401, 'CREDENTIAL_REVOKED', { reason: 'replaced' }))).toContain('replaced by a reconnect');
  expect(connectorErrorMessage(new Error('private provider token'))).not.toContain('private provider token');
});
