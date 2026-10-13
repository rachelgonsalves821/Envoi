// Read-only preflight for the v3 §29 hosted, real-Hermes gate.
// This proves release alignment, not any of the 23 behavioral steps.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactName = 'envoi-connector.mjs';

export function originOf(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Supply an HTTPS origin without a path, query, or credentials');
  }
  return url.origin;
}

export function releaseMatches(health, ready, sha) {
  return health?.ok === true && health.configurationValidated === true && health.releaseSha === sha && ready?.ready === true && ready.releaseSha === sha
    && ['database', 'objectStorageReadAccess', 'malwareScanner'].every(key => ready.checks?.[key]?.ready === true);
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function disposableHermesCommand(profile, platform = process.platform) {
  return platform === 'win32' ? path.win32.join(profile, 'bin', 'hermes.exe')
    : path.posix.join(profile, 'bin', 'hermes');
}

export function hermesVersion(text) {
  return typeof text === 'string' ? text.trim().match(/(?:^|\s)(v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?)(?=\s|$)/)?.[1]?.replace(/^v/, '') || null : null;
}

export function versionMatches(observed, expected) {
  return Boolean(hermesVersion(observed) && hermesVersion(observed) === hermesVersion(expected));
}

export function separateApiPort(envText, regularPort = 8642) {
  // Read only this nonsecret setting; never return the environment contents.
  const values = [...envText.matchAll(/^\s*(?:export\s+)?API_SERVER_PORT\s*=([^\r\n]*)$/gm)];
  const value = values.at(-1)?.[1]?.trim().match(/^(?:"(\d+)"|'(\d+)'|(\d+))\s*(?:#.*)?$/);
  const port = Number(value?.slice(1).find(Boolean));
  return Number.isInteger(regularPort) && regularPort > 0 && regularPort <= 65535
    && Number.isInteger(port) && port > 0 && port <= 65535 && port !== regularPort ? port : null;
}

export async function inspectDisposableProfile(profile, regularPort = 8642) {
  const entry = await lstat(profile).catch(() => null);
  const envPath = path.join(profile, '.env');
  const envEntry = await lstat(envPath).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink() || !envEntry?.isFile() || envEntry.isSymbolicLink()) return null;
  const envText = await readFile(envPath, 'utf8');
  return separateApiPort(envText, regularPort);
}

export function manifestMatches(local, hosted, localBytes, hostedBytes) {
  const expected = local?.artifacts?.[artifactName];
  const actual = hosted?.artifacts?.[artifactName];
  return Boolean(expected && actual && local.runtimes?.includes('hermes') && hosted.runtimes?.includes('hermes')
    && expected.sha256 === actual.sha256 && expected.size === actual.size
    && expected.sha256 === sha256(localBytes) && actual.sha256 === sha256(hostedBytes)
    && localBytes.length === expected.size && hostedBytes.length === actual.size);
}

async function get(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} returned HTTP ${response.status}`);
  return response;
}

function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim(); }

export async function preflight({ origin, sha, hermesHome, expectedHermesVersion, regularApiPort = 8642 }) {
  const checks = {};
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('An exact 40-character integration SHA is required');
  origin = originOf(origin);
  if (!path.isAbsolute(hermesHome)) throw new Error('Use an absolute disposable HERMES_HOME');
  if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(expectedHermesVersion || '')) throw new Error('Supply the expected Hermes version');
  if (!Number.isInteger(regularApiPort) || regularApiPort < 1 || regularApiPort > 65535) throw new Error('Supply the regular Hermes API port');
  const profile = path.resolve(hermesHome);
  const existing = path.resolve(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'hermes');
  if (profile.toLowerCase() === existing.toLowerCase()
    || existing.toLowerCase().startsWith(profile.toLowerCase() + path.sep)
    || profile.toLowerCase().startsWith(existing.toLowerCase() + path.sep)) {
    throw new Error('The disposable profile must not be the existing Hermes installation or its parent');
  }
  // The gate runner may live on its own branch; production sources must still
  // equal the deployed candidate byte-for-byte outside integrations/gates.
  const productionDiff = git('diff', sha, '--', '.', ':(exclude)integrations/gates');
  const untrackedProduction = git('ls-files', '--others', '--exclude-standard').split('\n')
    .filter(file => file && !file.startsWith('integrations/gates/'));
  checks.source = productionDiff === '' && untrackedProduction.length === 0 ? 'PASS' : 'FAIL';
  const [health, ready, localManifestBytes, localBundle, hostedManifestBytes, hostedBundle] = await Promise.all([
    get(`${origin}/health`).then(r => r.json()), get(`${origin}/ready`).then(r => r.json()),
    readFile(path.join(root, 'web/downloads/release.json')),
    readFile(path.join(root, 'web/downloads', artifactName)),
    get(`${origin}/web/downloads/release.json`).then(r => r.arrayBuffer()).then(Buffer.from),
    get(`${origin}/web/downloads/${artifactName}`).then(r => r.arrayBuffer()).then(Buffer.from)
  ]);
  checks.hostedRelease = releaseMatches(health, ready, sha) ? 'PASS' : 'FAIL';
  checks.bundle = manifestMatches(JSON.parse(localManifestBytes), JSON.parse(hostedManifestBytes), localBundle, hostedBundle) ? 'PASS' : 'FAIL';
  const apiServerPort = await inspectDisposableProfile(profile, regularApiPort).catch(() => null);
  checks.disposableProfile = apiServerPort !== null ? 'PASS' : 'FAIL';
  let observedHermesVersion = null;
  try {
    const hermesCommand = disposableHermesCommand(profile);
    const commandEntry = await lstat(hermesCommand);
    if (!commandEntry.isFile() || commandEntry.isSymbolicLink()) throw new Error('Disposable CLI is unavailable');
    const version = execFileSync(hermesCommand, ['--version'], {
      env: { ...process.env, HERMES_HOME: profile }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    observedHermesVersion = hermesVersion(version);
    checks.hermesCli = versionMatches(version, expectedHermesVersion) ? 'PASS' : 'FAIL';
  } catch { checks.hermesCli = 'FAIL'; }
  return { candidateSha: sha, origin, bundleSha256: sha256(hostedBundle),
    observedHermesVersion, expectedHermesVersion: hermesVersion(expectedHermesVersion), apiServerPort, regularApiPort, checks,
    verdict: Object.values(checks).every(value => value === 'PASS') ? 'READY_FOR_MODEL_TURN' : 'BLOCKED',
    modelTurn: 'UNPROVEN',
    note: 'Run a real model turn in the disposable profile before hosted steps. No Phase A behavioral step is proved by this preflight.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = new Map();
  let invalid = (process.argv.length - 2) % 2 !== 0;
  for (let i = 2; i < process.argv.length; i += 2) {
    if (values.has(process.argv[i])) invalid = true;
    values.set(process.argv[i], process.argv[i + 1]);
  }
  if (invalid || !['--origin', '--sha', '--hermes-home', '--hermes-version'].every(key => values.has(key))
    || [...values.keys()].some(key => !['--origin', '--sha', '--hermes-home', '--hermes-version', '--regular-api-port'].includes(key))
    || [...values.values()].some(value => !value)) {
    console.error('Usage: node integrations/gates/phase-a-hosted-preflight.mjs --origin https://<staging-host> --sha <40-character SHA> --hermes-home <absolute disposable path> --hermes-version <expected version> [--regular-api-port <regular profile port, default 8642>]');
    process.exitCode = 2;
  } else {
    try {
      const report = await preflight({ origin: values.get('--origin'), sha: values.get('--sha'), hermesHome: values.get('--hermes-home'),
        expectedHermesVersion: values.get('--hermes-version'), regularApiPort: values.has('--regular-api-port') ? Number(values.get('--regular-api-port')) : 8642 });
      console.log(JSON.stringify(report, null, 2));
      if (report.verdict !== 'READY_FOR_MODEL_TURN') process.exitCode = 1;
    } catch (error) { console.error(`Phase A preflight failed: ${error.message}`); process.exitCode = 1; }
  }
}
