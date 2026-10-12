import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const capabilityKeys = [
  'readSkill', 'invokeTrustedHelper', 'privateStorage', 'outboundHttps',
  'providerInvocation', 'verifiedWebhook', 'persistentProcess', 'sse', 'scheduledPolling',
];
export const requiredChecks = [
  'privateActivation', 'secretIsolation', 'closedAppWake', 'canonicalReply',
  'restartRecovery', 'duplicateWake', 'pause', 'revocation',
];
const modes = ['provider', 'webhook', 'envoi_link', 'poll', 'on_demand'];

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
  if (profile.schemaVersion !== 'host-plan-draft-1') throw new Error('Unsupported host-plan schema');
  objectWithKeys(profile.runtime, ['id', 'version', 'hostId']);
  if (!Object.values(profile.runtime).every(identifier)
    || !['id', 'version', 'hostId'].every((key) => identifier(profile.runtime[key]))) {
    throw new Error('Invalid runtime identity');
  }
  objectWithKeys(profile.target, ['releaseSha', 'helperVersion']);
  if (!(profile.target.releaseSha === null || (typeof profile.target.releaseSha === 'string'
    && /^[a-f0-9]{40}$/.test(profile.target.releaseSha)))
    || !(profile.target.helperVersion === null || identifier(profile.target.helperVersion))) {
    throw new Error('Invalid target release or helper');
  }
  objectWithKeys(profile.capabilities, capabilityKeys);
  if (!capabilityKeys.every((key) => typeof profile.capabilities[key] === 'boolean')) {
    throw new Error('Capabilities must be explicit booleans');
  }
  if (!Array.isArray(profile.evidence) || profile.evidence.length > modes.length) {
    throw new Error('Invalid conformance evidence');
  }
  const seenModes = new Set();
  for (const evidence of profile.evidence) {
    objectWithKeys(evidence, ['mode', 'runtime', 'releaseSha', 'helperVersion', 'checks']);
    if (!modes.includes(evidence.mode) || seenModes.has(evidence.mode)) {
      throw new Error('Invalid or duplicate evidence mode');
    }
    seenModes.add(evidence.mode);
    objectWithKeys(evidence.runtime, ['id', 'version', 'hostId']);
    if (!['id', 'version', 'hostId'].every((key) => evidence.runtime[key] === profile.runtime[key])
      || typeof evidence.releaseSha !== 'string'
      || !/^[a-f0-9]{40}$/.test(evidence.releaseSha) || !identifier(evidence.helperVersion)) {
      throw new Error('Evidence must pin the runtime, host, release and helper');
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
    || manifest.connectUrl !== 'https://www.envoi-agents.com/connect'
    || manifest.helperCommand !== 'envoi-link connect https://www.envoi-agents.com') {
    throw new Error('Only the reviewed unpublished Envoi manifest is supported');
  }
}

export function planHost(manifest, profile) {
  validateManifest(manifest);
  validateProfile(profile);
  const capabilities = profile.capabilities;
  const missing = ['readSkill', 'invokeTrustedHelper', 'privateStorage', 'outboundHttps']
    .filter((key) => !capabilities[key]);
  const candidates = [];
  if (missing.length === 0) {
    if (capabilities.providerInvocation) candidates.push('provider');
    if (capabilities.verifiedWebhook) candidates.push('webhook');
    if (capabilities.persistentProcess && capabilities.sse) candidates.push('envoi_link');
    if (capabilities.scheduledPolling) candidates.push('poll');
    candidates.push('on_demand');
  }
  const completeModes = candidates.filter((mode) => mode !== 'on_demand'
    && profile.evidence.some((entry) => entry.mode === mode
      && entry.releaseSha === profile.target.releaseSha
      && entry.helperVersion === profile.target.helperVersion
      && requiredChecks.every((key) => entry.checks[key]?.result === 'pass')));
  const selectedMode = missing.length ? null : completeModes[0] ?? 'on_demand';
  return {
    schemaVersion: 'host-plan-draft-1',
    state: missing.length ? 'unsupported_host' : 'contract_blocked',
    liveEnrollmentAllowed: false,
    selectedMode,
    candidateModes: candidates,
    reachability: selectedMode === null ? 'unavailable'
      : selectedMode === 'on_demand' ? 'on_demand' : 'unattended_evidence_recorded',
    evidenceAssessment: 'references_only_not_independent_host_verification',
    missingCapabilities: missing,
    nextAction: missing.length ? 'ask_owner_for_supported_trusted_host'
      : 'await_phase_b_contract_and_hosted_gate',
    plannedHelperInvocation: missing.length ? null : {
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
    process.stderr.write('Host planning failed: supply a valid host-plan-draft-1 profile. No helper was executed.\n');
    process.exitCode = 1;
  }
}
