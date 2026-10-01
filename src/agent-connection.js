// These reports describe completed setup checks, not live presence or an
// end-to-end messaging guarantee. Only allow structured, secret-free results.
const errorCodes = new Set([
  'GATEWAY_UNREACHABLE', 'GATEWAY_AUTH_FAILED', 'AGENT_NOT_FOUND',
  'GATEWAY_TEST_FAILED', 'CONNECTOR_START_FAILED', 'CONNECTION_TEST_FAILED'
]);

export function validateConnectionReport(input) {
  const invalid = () => { throw Object.assign(new Error('Invalid connection setup report'), { statusCode: 400 }); };
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !['version', 'runtime', 'phase', 'gatewayTest', 'errorCode'].includes(key))
    || input.version !== 1 || input.runtime !== 'openclaw'
    || !['ready', 'error'].includes(input.phase)) invalid();
  if (input.phase === 'ready' && (input.gatewayTest !== 'passed' || input.errorCode !== undefined)) invalid();
  if (input.phase === 'error' && (!['passed', 'failed'].includes(input.gatewayTest) || !errorCodes.has(input.errorCode))) invalid();
  return { version: 1, runtime: 'openclaw', phase: input.phase, gatewayTest: input.gatewayTest, ...(input.phase === 'error' ? { errorCode: input.errorCode } : {}) };
}

export function enrollmentConnectionStatus(record, agent, family, now = Date.now()) {
  const result = { enrollmentId: record.id, phase: 'waiting', expiresAt: record.expiresAt };
  if (record.revokedAt) result.phase = 'revoked';
  else if (!record.usedAt) {
    if (new Date(record.expiresAt).getTime() <= now) result.phase = 'expired';
  } else if (!agent || agent.status !== 'active' || agent.onboardingStatus !== 'approved' || !family || family.revokedAt) result.phase = 'revoked';
  else if (new Date(family.refreshExpiresAt).getTime() <= now) result.phase = 'expired';
  else {
    result.phase = 'enrolled';
    const setup = family.connectionSetup;
    if (setup?.version === 1 && setup.runtime === 'openclaw' && setup.checkedAt) {
      result.checkedAt = setup.checkedAt;
      if (setup.phase === 'ready' && setup.gatewayTest === 'passed') result.phase = 'ready';
      if (setup.phase === 'error' && errorCodes.has(setup.errorCode)) {
        result.phase = 'error';
        result.errorCode = setup.errorCode;
      }
    }
  }
  if (agent) result.agent = { id: agent.id, inboxId: record.agentInboxId, address: agent.address, name: agent.name };
  return result;
}
