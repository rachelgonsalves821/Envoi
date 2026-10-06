// These reports describe completed setup checks, not live presence or an
// end-to-end messaging guarantee. Only allow structured, secret-free results.
const errorCodes = new Set([
  'GATEWAY_UNREACHABLE', 'GATEWAY_AUTH_FAILED', 'AGENT_NOT_FOUND',
  'GATEWAY_TEST_FAILED', 'CONNECTOR_START_FAILED', 'CONNECTION_TEST_FAILED',
  'RUNTIME_UNREACHABLE', 'RUNTIME_AUTH_FAILED', 'RUNTIME_TEST_FAILED',
  'MODEL_NOT_CONFIGURED', 'PROVIDER_AUTH_FAILED', 'PROFILE_NOT_FOUND',
  'RUNTIME_INCOMPATIBLE', 'MCP_TEST_FAILED',
  'MODEL_CREDENTIAL_MISSING', 'MODEL_CREDENTIAL_INVALID', 'PROVIDER_UNREACHABLE',
  'MODEL_TEST_FAILED', 'HERMES_API_DISABLED', 'HERMES_API_AUTH_FAILED',
  'HERMES_API_UNREACHABLE', 'HERMES_API_INCOMPATIBLE', 'HERMES_PROFILE_AMBIGUOUS',
  'HERMES_CONFIG_UNSUPPORTED', 'CONFIG_AMBIGUOUS', 'CONFIG_INVALID',
  'CONFIG_CHANGED', 'CONFIG_UNSUPPORTED', 'PROFILE_ALREADY_CONNECTED',
  'STATE_UNAVAILABLE', 'STATE_INVALID', 'RUNTIME_NOT_FOUND',
  'GATEWAY_KEY_MISSING', 'GATEWAY_NOT_ENABLED', 'GATEWAY_INCOMPATIBLE',
  'MODEL_NOT_READY', 'SETUP_CANCELLED', 'RELAY_UNAVAILABLE', 'TOOLS_NOT_READY',
  'MODEL_CONFIGURATION_INVALID', 'RUNTIME_CONFIGURATION_INVALID', 'RUNTIME_HOST_MISMATCH'
]);

export const connectorRuntimes = new Set(['openclaw', 'hermes', 'grok', 'muse']);

export function validateConnectorRuntime(value, fallback = 'openclaw') {
  const runtime = value === undefined ? fallback : value;
  if (!connectorRuntimes.has(runtime)) throw Object.assign(new Error('Unsupported connector runtime'), { statusCode: 400 });
  return runtime;
}

export function validateConnectionReport(input) {
  const invalid = () => { throw Object.assign(new Error('Invalid connection setup report'), { statusCode: 400 }); };
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !['version', 'runtime', 'phase', 'runtimeTest', 'gatewayTest', 'errorCode'].includes(key))
    || input.version !== 1 || !connectorRuntimes.has(input.runtime)
    || !['ready', 'error'].includes(input.phase)) invalid();
  if (input.gatewayTest !== undefined && (input.runtime !== 'openclaw' || (input.runtimeTest !== undefined && input.runtimeTest !== input.gatewayTest))) invalid();
  const runtimeTest = input.runtimeTest ?? input.gatewayTest;
  if (input.phase === 'ready' && (runtimeTest !== 'passed' || input.errorCode !== undefined)) invalid();
  if (input.phase === 'error' && (!['passed', 'failed'].includes(runtimeTest) || !errorCodes.has(input.errorCode))) invalid();
  return { version: 1, runtime: input.runtime, phase: input.phase, runtimeTest, ...(input.gatewayTest !== undefined ? { gatewayTest: input.gatewayTest } : {}), ...(input.phase === 'error' ? { errorCode: input.errorCode } : {}) };
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
    if (setup?.version === 1 && connectorRuntimes.has(setup.runtime) && setup.checkedAt
      && (!record.runtime || record.runtime === setup.runtime)
      && (!family.runtime || family.runtime === setup.runtime)) {
      result.checkedAt = setup.checkedAt;
      if (setup.phase === 'ready' && (setup.runtimeTest ?? setup.gatewayTest) === 'passed') result.phase = 'ready';
      if (setup.phase === 'error' && errorCodes.has(setup.errorCode)) {
        result.phase = 'error';
        result.errorCode = setup.errorCode;
      }
    }
  }
  if (agent) result.agent = { id: agent.id, inboxId: record.agentInboxId, address: agent.address, name: agent.name };
  return result;
}
