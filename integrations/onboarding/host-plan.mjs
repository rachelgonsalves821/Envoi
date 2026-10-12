import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const capabilityKeys = [
  'readSkill', 'invokeTrustedHelper', 'privateStorage', 'outboundHttps',
  'remoteMcpOAuth', 'providerConnector', 'authenticatedRest',
  'providerInvocation', 'verifiedWebhook', 'persistentProcess', 'sse', 'scheduledPolling',
];
const connectionRoutes = [
  ['local_helper', 'invokeTrustedHelper'],
  ['remote_mcp_oauth', 'remoteMcpOAuth'],
  ['provider_connector', 'providerConnector'],
  ['authenticated_rest', 'authenticatedRest'],
];
export const requiredChecks = [
  'privateActivation', 'secretIsolation', 'closedAppWake', 'canonicalReply',
  'restartRecovery', 'duplicateWake', 'pause', 'revocation',
];
const modes = ['provider', 'webhook', 'envoi_link', 'poll', 'on_demand', 'a2a'];

function objectWithKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Invalid host-plan input');
  }
}

function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
}

function validateProfile(profile) {
  objectWithKeys(profile, ['schemaVersion', 'runtime', 'target', 'capabilities', 'evidence']);
  if (profile.schemaVersion !== 'host-plan-draft-2') throw new Error('Unsupported host-plan schema');
  objectWithKeys(profile.runtime, ['id', 'version', 'hostId']);
  if (!Object.values(profile.runtime).every(identifier)
    || !['id', 'version', 'hostId'].every((key) => identifier(profile.runtime[key]))) {
    throw new Error('Invalid runtime identity');
  }
  objectWithKeys(profile.target, ['releaseSha', 'integrationVersion']);
  if (!(profile.target.releaseSha === null || (typeof profile.target.releaseSha === 'string'
    && /^[a-f0-9]{40}$/.test(profile.target.releaseSha)))
    || !(profile.target.integrationVersion === null || identifier(profile.target.integrationVersion))) {
    throw new Error('Invalid target release or integration version');
  }
  objectWithKeys(profile.capabilities, capabilityKeys);
  if (!capabilityKeys.every((key) => typeof profile.capabilities[key] === 'boolean')) {
    throw new Error('Capabilities must be explicit booleans');
  }
  if (!Array.isArray(profile.evidence) || profile.evidence.length > modes.length * connectionRoutes.length) {
    throw new Error('Invalid conformance evidence');
  }
  const seenRouteModes = new Set();
  for (const evidence of profile.evidence) {
    objectWithKeys(evidence, ['connectionRoute', 'mode', 'runtime', 'releaseSha', 'integrationVersion', 'checks']);
    const routeMode = `${evidence.connectionRoute}:${evidence.mode}`;
    if (!connectionRoutes.some(([route]) => route === evidence.connectionRoute)
      || !modes.includes(evidence.mode) || seenRouteModes.has(routeMode)) {
      throw new Error('Invalid or duplicate route/mode evidence');
    }
    seenRouteModes.add(routeMode);
    objectWithKeys(evidence.runtime, ['id', 'version', 'hostId']);
    if (!['id', 'version', 'hostId'].every((key) => evidence.runtime[key] === profile.runtime[key])
      || typeof evidence.releaseSha !== 'string'
      || !/^[a-f0-9]{40}$/.test(evidence.releaseSha) || !identifier(evidence.integrationVersion)) {
      throw new Error('Evidence must pin the runtime, host, release and integration');
    }
    objectWithKeys(evidence.checks, requiredChecks);
    for (const observation of Object.values(evidence.checks)) {
      objectWithKeys(observation, ['result', 'reference']);
      if (!['pass', 'fail', 'unproven'].includes(observation.result)) {
        throw new Error('Invalid conformance result');
      }
      if (observation.result === 'pass') {
        let reference;
        try { reference = new URL(observation.reference); } catch { throw new Error('Missing evidence reference'); }
        if (reference.protocol !== 'https:' || reference.username || reference.password
          || reference.search || reference.hash) throw new Error('Evidence requires a private reviewed HTTPS reference without URL credentials');
      } else if (observation.reference !== undefined) {
        throw new Error('Only passing checks carry evidence references');
      }
    }
  }
}

function validateManifest(manifest) {
  if (manifest?.name !== 'envoi-agent-connect' || manifest.status !== 'draft'
    || manifest.published !== false || manifest.skill !== 'SKILL.md'
    || manifest.heartbeat !== 'HEARTBEAT.md'
    || manifest.coreContract?.id !== 'agent-registration'
    || manifest.coreContract?.version !== 1
    || manifest.coreContract?.publishedSha !== '36f7943646f245ec1ac96bec706690fa370f3780'
    || manifest.availabilitySource !== 'GET /api/onboarding/routes'
    || JSON.stringify(manifest.offeredConnectionRoutes) !== '[]'
    || JSON.stringify(manifest.offeredDeliveryModes) !== '[]'
    || manifest.connectUrl !== 'https://www.envoi-agents.com/connect'
    || manifest.helperCommand !== 'envoi-link connect https://www.envoi-agents.com'
    || JSON.stringify(manifest.connectionRoutes) !== JSON.stringify(connectionRoutes.map(([route]) => route))
    || JSON.stringify(manifest.deliveryModes) !== JSON.stringify(modes)) {
    throw new Error('Only the reviewed unpublished Envoi manifest is supported');
  }
}

function availableFromServer(snapshot) {
  if (snapshot === null) return null;
  objectWithKeys(snapshot, [
    'asOf', 'contract', 'registrationEnabled', 'installationsEnabled', 'routes', 'deliveryModes',
  ]);
  if (snapshot.contract?.id !== 'agent-registration' || snapshot.contract?.version !== 1
    || typeof snapshot.registrationEnabled !== 'boolean'
    || typeof snapshot.installationsEnabled !== 'boolean'
    || !Array.isArray(snapshot.routes) || !Array.isArray(snapshot.deliveryModes)) {
    throw new Error('Invalid route availability');
  }
  const expectedRoutes = connectionRoutes.map(([route]) => route);
  const routes = snapshot.routes.map((item) => {
    objectWithKeys(item, ['connectionRoute', 'available']);
    if (typeof item.available !== 'boolean') throw new Error('Invalid route availability');
    return item.connectionRoute;
  });
  const delivered = snapshot.deliveryModes.map((item) => {
    objectWithKeys(item, ['deliveryMode', 'available']);
    if (typeof item.available !== 'boolean') throw new Error('Invalid route availability');
    return item.deliveryMode;
  });
  if (routes.length !== expectedRoutes.length || new Set(routes).size !== routes.length
    || !routes.every((route) => expectedRoutes.includes(route))
    || delivered.length !== modes.length || new Set(delivered).size !== delivered.length
    || !delivered.every((mode) => modes.includes(mode))) {
    throw new Error('Invalid route availability');
  }
  const registrationOn = snapshot.registrationEnabled && snapshot.installationsEnabled;
  const routeMap = new Map(snapshot.routes.map((item) => [item.connectionRoute, item.available]));
  const modeMap = new Map(snapshot.deliveryModes.map((item) => [item.deliveryMode, item.available]));
  if (routeMap.get('local_helper') !== registrationOn
    || (routeMap.get('authenticated_rest') && !registrationOn)
    || routeMap.get('remote_mcp_oauth') || routeMap.get('provider_connector')
    || modeMap.get('envoi_link') !== registrationOn
    || modes.some((mode) => mode !== 'envoi_link' && modeMap.get(mode))) {
    throw new Error('Invalid route availability');
  }
  return {
    routes: new Set(snapshot.routes.filter((item) => item.available).map((item) => item.connectionRoute)),
    modes: new Set(snapshot.deliveryModes.filter((item) => item.available).map((item) => item.deliveryMode)),
  };
}

export function planHost(manifest, profile, routeAvailability = null) {
  validateManifest(manifest);
  validateProfile(profile);
  // Only the public server response may offer a route. A host profile is a claim,
  // and a successful wake probe does not enable a mode that Envoi has disabled.
  const offered = availableFromServer(routeAvailability);
  const capabilities = profile.capabilities;
  const missing = ['readSkill', 'privateStorage', 'outboundHttps']
    .filter((key) => !capabilities[key]);
  const candidateRoutes = missing.length ? [] : connectionRoutes
    .filter(([, capability]) => capabilities[capability]).map(([route]) => route);
  if (!missing.length && !candidateRoutes.length) missing.push('supported_connection_route');
  const modesForRoute = (route) => {
    const candidates = [];
    if (capabilities.providerInvocation) candidates.push('provider');
    if (capabilities.verifiedWebhook) candidates.push('webhook');
    if (['local_helper', 'authenticated_rest'].includes(route)
      && capabilities.persistentProcess && capabilities.sse) candidates.push('envoi_link');
    if (capabilities.scheduledPolling) candidates.push('poll');
    candidates.push('on_demand');
    return candidates;
  };
  const completeModesForRoute = (route) => modesForRoute(route).filter((mode) => mode !== 'on_demand'
    && profile.evidence.some((entry) => entry.mode === mode && entry.connectionRoute === route
      && entry.releaseSha === profile.target.releaseSha
      && entry.integrationVersion === profile.target.integrationVersion
      && requiredChecks.every((key) => entry.checks[key]?.result === 'pass')));
  const offeredRoutes = offered ? candidateRoutes.filter((route) => offered.routes.has(route)) : [];
  const selectedConnectionRoute = offeredRoutes.find((route) => completeModesForRoute(route)
    .some((mode) => offered.modes.has(mode))) ?? offeredRoutes[0] ?? null;
  const candidates = selectedConnectionRoute ? modesForRoute(selectedConnectionRoute)
    .filter((mode) => offered.modes.has(mode)) : [];
  const completeModes = selectedConnectionRoute ? completeModesForRoute(selectedConnectionRoute)
    .filter((mode) => offered.modes.has(mode)) : [];
  const selectedMode = completeModes[0] ?? candidates[0] ?? null;
  return {
    schemaVersion: 'host-plan-draft-2',
    state: missing.length ? 'unsupported_host' : 'contract_blocked',
    liveEnrollmentAllowed: false,
    selectedConnectionRoute,
    candidateConnectionRoutes: candidateRoutes,
    selectedDeliveryMode: selectedMode,
    candidateDeliveryModes: candidates,
    reachability: selectedMode === null ? 'unavailable'
      : completeModes.includes(selectedMode) ? 'unattended_evidence_recorded' : 'not_verified_closed_app',
    evidenceAssessment: 'references_only_not_independent_host_verification',
    missingCapabilities: missing,
    nextAction: missing.length ? 'ask_owner_for_supported_trusted_host'
      : offered === null ? 'await_server_route_availability'
        : selectedConnectionRoute === null || selectedMode === null ? 'route_or_delivery_not_available'
          : 'await_phase_b_server_and_hosted_gate',
    plannedHelperInvocation: selectedConnectionRoute !== 'local_helper' ? null : {
      executable: 'envoi-link',
      args: ['connect', 'https://www.envoi-agents.com'],
    },
  };
}

export async function consumeHostPlan(profilePath) {
  const [manifestSource, profileSource] = await Promise.all([
    readFile(new URL('./skill/skill.json', import.meta.url), 'utf8'),
    readFile(profilePath, 'utf8'),
  ]);
  if (profileSource.length > 32_768) throw new Error('Host profile exceeds size limit');
  return planHost(JSON.parse(manifestSource), JSON.parse(profileSource));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node integrations/onboarding/host-plan.mjs <host-profile.json>');
    process.stdout.write(`${JSON.stringify(await consumeHostPlan(process.argv[2]), null, 2)}\n`);
  } catch {
    process.stderr.write('Host planning failed: supply a valid host-plan-draft-2 profile. No helper was executed.\n');
    process.exitCode = 1;
  }
}
