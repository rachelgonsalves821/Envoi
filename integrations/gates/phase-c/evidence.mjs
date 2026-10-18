import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const evidenceRows = Array.from({ length: 24 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
const shaPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_.\/-]+$/.test(value)
  && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || !part);
const references = value => Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(reference);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const count = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 1000000;

export function createEvidenceTemplate() {
  return {
    schemaVersion: 1,
    scope: 'phase_c_single_host',
    candidateSha: '',
    runtime: { product: '', version: '', route: '' },
    artifactHashes: { connector: '', helper: '' },
    contractRefs: [],
    phaseBRefs: [],
    approvalRefs: [],
    rows: evidenceRows.map(id => ({ id, status: 'not_run', evidenceKind: 'not_run', candidateSha: '', observedAt: '',
      expectedOutcome: '', actualOutcome: '', modelInvocationCount: null, canonicalEffectCount: null, evidenceRefs: [] }))
  };
}

export function validateEvidence(manifest) {
  const errors = [];
  const rejectUnknown = (value, allowed, location) => {
    if (record(value) && Object.keys(value).some(key => !allowed.includes(key))) errors.push(`${location}: unexpected fields`);
  };
  if (!record(manifest)) return { scope: 'metadata_review_only', reviewReady: false, errors: ['manifest: expected object'] };
  rejectUnknown(manifest, Object.keys(createEvidenceTemplate()), 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.scope !== 'phase_c_single_host') errors.push('manifest: unsupported schema or scope');
  if (typeof manifest.candidateSha !== 'string' || !shaPattern.test(manifest.candidateSha)) errors.push('candidate: full SHA required');
  rejectUnknown(manifest.runtime, ['product', 'version', 'route'], 'runtime');
  if (!record(manifest.runtime) || !['product', 'version', 'route'].every(key => text(manifest.runtime[key]))) errors.push('runtime: product, version and route required');
  rejectUnknown(manifest.artifactHashes, ['connector', 'helper'], 'artifacts');
  if (!record(manifest.artifactHashes) || !['connector', 'helper'].every(key => typeof manifest.artifactHashes[key] === 'string'
    && hashPattern.test(manifest.artifactHashes[key]))) errors.push('artifacts: connector and helper SHA256 required');
  for (const key of ['contractRefs', 'phaseBRefs', 'approvalRefs']) {
    if (!references(manifest[key])) errors.push(`${key}: relative evidence references required`);
  }
  const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
  if (rows.length !== evidenceRows.length) errors.push('rows: exactly 24 observations required');
  const seen = new Set();
  for (const row of rows) {
    if (!record(row) || !evidenceRows.includes(row.id) || seen.has(row.id)) {
      errors.push('rows: invalid or duplicate row');
      continue;
    }
    seen.add(row.id);
    rejectUnknown(row, ['id', 'status', 'evidenceKind', 'candidateSha', 'observedAt', 'expectedOutcome', 'actualOutcome',
      'modelInvocationCount', 'canonicalEffectCount', 'evidenceRefs'], row.id);
    if (!['not_run', 'pass', 'fail', 'blocked'].includes(row.status)) errors.push(`${row.id}: invalid status`);
    if (!['not_run', 'automated', 'diagnostic', 'hosted'].includes(row.evidenceKind)) errors.push(`${row.id}: invalid evidence kind`);
    if (row.status !== 'pass' || row.evidenceKind !== 'hosted') errors.push(`${row.id}: hosted passing evidence outstanding`);
    if (typeof row.candidateSha !== 'string' || !shaPattern.test(row.candidateSha) || row.candidateSha !== manifest.candidateSha) errors.push(`${row.id}: candidate mismatch`);
    if (typeof row.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt)
      || !Number.isFinite(Date.parse(row.observedAt)) || new Date(row.observedAt).toISOString() !== row.observedAt) errors.push(`${row.id}: canonical UTC timestamp required`);
    if (!references(row.evidenceRefs)) errors.push(`${row.id}: relative evidence references required`);
    if (!text(row.expectedOutcome) || !text(row.actualOutcome)) errors.push(`${row.id}: bounded expected and actual outcomes required`);
    if (!count(row.modelInvocationCount) || !count(row.canonicalEffectCount)
      || (row.modelInvocationCount === null) !== (row.canonicalEffectCount === null)) errors.push(`${row.id}: paired nonnegative observation counts required`);
    if (['C13', 'C14', 'C15'].includes(row.id) && (row.modelInvocationCount === null || row.canonicalEffectCount === null)) {
      errors.push(`${row.id}: recovery evidence must distinguish model invocations and canonical effects`);
    }
  }
  if (evidenceRows.some(id => !seen.has(id))) errors.push('rows: missing observations');
  return { scope: 'metadata_review_only', reviewReady: errors.length === 0, errors };
}

export async function inspectEvidenceFile(filename) {
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.size > 1024 * 1024) throw new Error();
    const handle = await open(filename, 'r');
    let manifest;
    try {
      if (!(await handle.stat()).isFile()) throw new Error();
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 1024 * 1024) throw new Error();
      manifest = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally { await handle.close(); }
    const result = validateEvidence(manifest);
    if (!result.reviewReady) return { ...result, referencesChecked: false };
    const sources = [...manifest.contractRefs, ...manifest.phaseBRefs, ...manifest.approvalRefs,
      ...manifest.rows.flatMap(row => row.evidenceRefs)];
    const unique = [...new Set(sources)];
    if (unique.length > 512) return { ...result, reviewReady: false, referencesChecked: false, errors: ['references: too many proof files'] };
    const root = await realpath(dirname(resolve(filename)));
    try {
      for (const source of unique) {
        const candidate = resolve(root, source);
        const actual = await realpath(candidate);
        const inside = relative(root, actual);
        if (!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) throw new Error();
        const info = await lstat(candidate);
        if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw new Error();
      }
    } catch {
      return { ...result, reviewReady: false, referencesChecked: false,
        errors: ['references: proof files must be nonempty, bounded regular files inside the evidence root'] };
    }
    return { ...result, referencesChecked: true };
  } catch {
    return { scope: 'metadata_review_only', reviewReady: false, referencesChecked: false, errors: ['manifest: unreadable, oversized or invalid JSON'] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--template') process.stdout.write(`${JSON.stringify(createEvidenceTemplate(), null, 2)}\n`);
  else {
    const result = await inspectEvidenceFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.reviewReady ? 0 : 2;
  }
}
