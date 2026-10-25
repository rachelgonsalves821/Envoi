// Read-only artifact agreement check for the first hosted Phase B batch.
// A passing report does not prove onboarding, wake, rollback, or a model turn.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const downloads = ['envoi-connector.mjs', 'envoi-openclaw.mjs'];

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function originOf(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Supply a bare HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}

export function releaseMatches(health, ready, sha) {
  return health?.ok === true && health.configurationValidated === true && health.releaseSha === sha
    && ready?.ready === true && ready.releaseSha === sha
    && ['database', 'objectStorageReadAccess', 'malwareScanner'].every(key => ready.checks?.[key]?.ready === true);
}

export function artifactMatches(entry, local, served, installed) {
  return Boolean(entry && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.size)
    && entry.size > 0 && [local, served, installed].every(bytes => bytes.length === entry.size && sha256(bytes) === entry.sha256));
}

export function manifestMatches(local, served) {
  return local?.version === 1 && served?.version === 1
    && ['hermes', 'openclaw'].every(runtime => local.runtimes?.includes(runtime) && served.runtimes?.includes(runtime))
    && downloads.every(name => {
      const expected = local.artifacts?.[name];
      const actual = served.artifacts?.[name];
      return expected && actual && expected.sha256 === actual.sha256 && expected.size === actual.size;
    });
}

async function regularFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Every installed artifact path must be absolute');
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('invalid installed file');
    return await readFile(file);
  } catch { throw new Error('An installed artifact is missing or is not a readable regular file'); }
}

async function get(origin, pathname) {
  const response = await fetch(`${origin}${pathname}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GET ${pathname} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sourceMatches(sha) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  return git('rev-parse', 'HEAD') === sha && git('status', '--porcelain') === '';
}

function parseJson(bytes) {
  try { return JSON.parse(bytes); }
  catch { throw new Error('A release response was not valid JSON'); }
}

export async function preflight({ origin, sha, installedHermesSkill, installedHermesHelper, installedHermesConnector,
  installedOpenclawSkill, installedOpenclawHelper, installedOpenclawConnector, installedOpenclawBundle }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('An exact 40-character candidate SHA is required');
  origin = originOf(origin);
  const checks = { cleanCandidate: sourceMatches(sha) ? 'PASS' : 'FAIL' };
  const [healthBytes, readyBytes, localManifestBytes, servedManifestBytes, localSkill, servedSkill,
    hermesSkill, openclawSkill, localHelper, hermesHelper, openclawHelper] = await Promise.all([
    get(origin, '/health'), get(origin, '/ready'), readFile(path.join(root, 'web/downloads/release.json')),
    get(origin, '/web/downloads/release.json'), readFile(path.join(root, 'integrations/onboarding/skill/SKILL.md')),
    get(origin, '/connect/SKILL.md'), regularFile(installedHermesSkill), regularFile(installedOpenclawSkill),
    readFile(path.join(root, 'integrations/onboarding/dist/envoi-link.mjs')),
    regularFile(installedHermesHelper), regularFile(installedOpenclawHelper)
  ]);
  const health = parseJson(healthBytes); const ready = parseJson(readyBytes);
  const localManifest = parseJson(localManifestBytes); const servedManifest = parseJson(servedManifestBytes);
  checks.release = releaseMatches(health, ready, sha) ? 'PASS' : 'FAIL';
  checks.manifest = manifestMatches(localManifest, servedManifest) ? 'PASS' : 'FAIL';
  checks.skill = [servedSkill, hermesSkill, openclawSkill].every(bytes => sha256(bytes) === sha256(localSkill)) ? 'PASS' : 'FAIL';
  checks.privateHelper = [hermesHelper, openclawHelper].every(bytes => sha256(bytes) === sha256(localHelper)) ? 'PASS' : 'FAIL';
  const artifacts = { skillSha256: sha256(servedSkill), helperSha256: sha256(localHelper) };
  for (const [name, installed] of [['envoi-connector.mjs', [installedHermesConnector, installedOpenclawConnector]],
    ['envoi-openclaw.mjs', [installedOpenclawBundle]]]) {
    const [local, served, ...installedBytes] = await Promise.all([
      readFile(path.join(root, 'web/downloads', name)), get(origin, `/web/downloads/${name}`),
      ...installed.map(regularFile)
    ]);
    checks[name] = checks.manifest === 'PASS' && installedBytes.every(bytes => artifactMatches(localManifest.artifacts[name], local, served, bytes)) ? 'PASS' : 'FAIL';
    artifacts[name] = { sha256: sha256(served), size: served.length };
  }
  return { candidateSha: sha, observedAt: new Date().toISOString(), checks, artifacts,
    verdict: Object.values(checks).every(value => value === 'PASS') ? 'ARTIFACTS_MATCHED' : 'BLOCKED',
    hostedOnboarding: 'UNPROVEN', closedAppWake: 'UNPROVEN', pairedRollback: 'UNPROVEN' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowed = ['--origin', '--sha', '--installed-hermes-skill', '--installed-hermes-helper', '--installed-hermes-connector',
    '--installed-openclaw-skill', '--installed-openclaw-helper', '--installed-openclaw-connector', '--installed-openclaw-bundle'];
  const args = process.argv.slice(2); const values = new Map();
  let invalid = args.length !== allowed.length * 2;
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values.has(args[i]) || !args[i + 1]) invalid = true;
    values.set(args[i], args[i + 1]);
  }
  if (invalid || allowed.some(key => !values.has(key))) {
    console.error('Usage: node integrations/gates/phase-b-artifact-preflight.mjs --origin https://<staging-host> --sha <40-character SHA> --installed-hermes-skill <path> --installed-hermes-helper <path> --installed-hermes-connector <path> --installed-openclaw-skill <path> --installed-openclaw-helper <path> --installed-openclaw-connector <path> --installed-openclaw-bundle <path>');
    process.exitCode = 2;
  } else {
    try {
      const report = await preflight({ origin: values.get('--origin'), sha: values.get('--sha'),
        installedHermesSkill: values.get('--installed-hermes-skill'), installedHermesHelper: values.get('--installed-hermes-helper'),
        installedHermesConnector: values.get('--installed-hermes-connector'), installedOpenclawSkill: values.get('--installed-openclaw-skill'),
        installedOpenclawHelper: values.get('--installed-openclaw-helper'), installedOpenclawConnector: values.get('--installed-openclaw-connector'),
        installedOpenclawBundle: values.get('--installed-openclaw-bundle') });
      console.log(JSON.stringify(report, null, 2));
      if (report.verdict !== 'ARTIFACTS_MATCHED') process.exitCode = 1;
    } catch (error) { console.error(`Phase B artifact preflight failed: ${error.message}`); process.exitCode = 1; }
  }
}
