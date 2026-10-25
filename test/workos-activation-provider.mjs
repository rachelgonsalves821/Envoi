// Test-only SDK boundary. The real server/auth/storage/claim/activation code runs unchanged.
// Loaded solely through NODE_OPTIONS for this disposable HTTP regression child.
import { registerHooks } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@workos-inc/node'
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context);
  }
});

const state = () => JSON.parse(readFileSync(process.env.ENVOI_TEST_WORKOS_FIXTURE_FILE, 'utf8'));
const sessionId = value => `session_activation_${value.userId}`;
const claims = () => `header.${Buffer.from(JSON.stringify({ sid: sessionId(state()), iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
const user = value => ({ id: value.userId, email: 'activation@example.test', emailVerified: true, firstName: 'Activation', lastName: 'Fixture' });

export class WorkOS {
  constructor() {
    this.userManagement = {
      loadSealedSession: ({ sessionData }) => ({
        authenticate: async () => {
          const value = state();
          return sessionData === 'activation_fixture_cookie'
            ? { authenticated: true, user: user(value), sessionId: sessionId(value), accessToken: claims(), organizationId: value.workosOrganizationId }
            : { authenticated: false, reason: 'invalid_session_cookie' };
        }
      }),
      getSessionFromCookie: async () => ({ accessToken: claims(), refreshToken: 'fixture_refresh' }),
      listOrganizationMemberships: async ({ userId, organizationId }) => {
        const value = state();
        appendFileSync(process.env.ENVOI_TEST_WORKOS_FIXTURE_FILE + '.calls', JSON.stringify({ userId, organizationId }) + '\n');
        if (value.unavailable) throw new Error('Synthetic provider unavailable');
        const data = userId === value.userId && organizationId === value.workosOrganizationId && value.active !== false
          ? [{ id: 'membership_activation_fixture', userId, organizationId, status: 'active', role: { slug: value.role || 'admin' } }]
          : [];
        return { data };
      }
    };
  }
}
