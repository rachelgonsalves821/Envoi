import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createEvidenceTemplate, inspectEvidenceFile, validateEvidence } from './evidence.mjs';

function completeMetadata() {
  const manifest = createEvidenceTemplate();
  manifest.candidateSha = 'a'.repeat(40);
  manifest.runtime = { product: 'Hermes', version: 'test-version', route: 'local-helper' };
  manifest.artifactHashes = { connector: 'b'.repeat(64), helper: 'c'.repeat(64) };
  manifest.contractRefs = ['contracts/review.md'];
  manifest.phaseBRefs = ['phase-b/accepted.md'];
  manifest.approvalRefs = ['approvals/run.md'];
  manifest.rows = manifest.rows.map(row => ({ ...row, status: 'pass', evidenceKind: 'hosted', candidateSha: manifest.candidateSha,
    observedAt: '2026-10-17T17:00:00.000Z', expectedOutcome: 'Expected fixture observation', actualOutcome: 'Recorded fixture observation',
    modelInvocationCount: 1, canonicalEffectCount: 1, evidenceRefs: [`observations/${row.id}.md`] }));
  return manifest;
}

async function evidenceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'envoi-phase-c-proof-'));
  const root = join(directory, 'evidence'); await mkdir(root);
  const filename = join(root, 'manifest.json');
  const manifest = completeMetadata();
  const save = async () => { await writeFile(filename, JSON.stringify(manifest)); };
  const populate = async () => {
    const sources = [...manifest.contractRefs, ...manifest.phaseBRefs, ...manifest.approvalRefs, ...manifest.rows.flatMap(row => row.evidenceRefs)];
    for (const source of sources) {
      const target = join(root, source); await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'Synthetic evidence fixture, not a real hosted result.');
    }
  };
  return { directory, root, filename, manifest, save, populate, async close() {
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !basename(directory).startsWith('envoi-phase-c-proof-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  } };
}

describe('offline Phase C evidence metadata', () => {
  it('starts with all 24 rows unrun and cannot certify the empty template', () => {
    const manifest = createEvidenceTemplate();
    expect(manifest.rows).toHaveLength(24);
    expect(manifest.rows.every(row => row.status === 'not_run')).toBe(true);
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it('labels complete metadata reviewable, never a verified gate pass', () => {
    const manifest = completeMetadata();
    const before = structuredClone(manifest);
    expect(validateEvidence(manifest)).toEqual({ scope: 'metadata_review_only', reviewReady: true, errors: [] });
    expect(manifest).toEqual(before);
  });

  it.each(['automated', 'diagnostic', 'not_run'])('does not promote %s results to hosted acceptance', evidenceKind => {
    const manifest = completeMetadata(); manifest.rows[0].evidenceKind = evidenceKind;
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it.each(['not_run', 'fail', 'blocked', 'waived'])('keeps %s rows outstanding', status => {
    const manifest = completeMetadata(); manifest.rows[0].status = status;
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it('rejects mixed candidates, shortened SHAs and invalid artifact hashes', () => {
    const manifest = completeMetadata(); manifest.rows[0].candidateSha = 'd'.repeat(40);
    expect(validateEvidence(manifest).reviewReady).toBe(false);
    manifest.rows[0].candidateSha = manifest.candidateSha; manifest.candidateSha = 'aaaaaaa';
    expect(validateEvidence(manifest).reviewReady).toBe(false);
    manifest.candidateSha = 'a'.repeat(40); manifest.artifactHashes.helper = 'unknown';
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it.each([['b'.repeat(64)], { toString: 'PRIVATE_SENTINEL' }, 123, true, null])('rejects malformed hash/SHA types without coercion or exceptions: %j', value => {
    for (const location of ['artifact', 'candidate', 'row']) {
      const manifest = completeMetadata();
      if (location === 'artifact') manifest.artifactHashes.connector = value as never;
      else if (location === 'candidate') manifest.candidateSha = value as never;
      else manifest.rows[0].candidateSha = value as never;
      const serialized = JSON.parse(JSON.stringify(manifest));
      expect(() => validateEvidence(serialized)).not.toThrow();
      const result = validateEvidence(serialized);
      expect(result.reviewReady).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    }
  });

  it('rejects arrays containing otherwise valid digest strings at every digest location', () => {
    const artifact = completeMetadata(); artifact.artifactHashes.connector = ['b'.repeat(64)] as never;
    const candidate = completeMetadata(); candidate.candidateSha = ['a'.repeat(40)] as never;
    const row = completeMetadata(); row.rows[0].candidateSha = ['a'.repeat(40)] as never;
    for (const manifest of [artifact, candidate, row]) expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it('rejects missing or duplicated observations', () => {
    const manifest = completeMetadata(); manifest.rows[23] = { ...manifest.rows[0] };
    expect(validateEvidence(manifest).reviewReady).toBe(false);
    manifest.rows.pop(); expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it.each(['../private.json', '/private.json', 'C:\\private.json', 'https://host/file?token=secret', 'logs/../private.json'])('rejects unsafe reference %s without echoing it', evidenceRef => {
    const manifest = completeMetadata(); manifest.rows[0].evidenceRefs = [evidenceRef];
    const result = validateEvidence(manifest);
    expect(result.reviewReady).toBe(false);
    expect(JSON.stringify(result)).not.toContain(evidenceRef);
  });

  it.each(['2026-02-30T00:00:00.000Z', '2026-10-17T17:00:00-04:00', 'invalid'])('rejects invalid or noncanonical observation time %s', observedAt => {
    const manifest = completeMetadata(); manifest.rows[0].observedAt = observedAt;
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it('requires contract, prior route acceptance and human approval references', () => {
    for (const field of ['contractRefs', 'phaseBRefs', 'approvalRefs'] as const) {
      const manifest = completeMetadata(); manifest[field] = [];
      expect(validateEvidence(manifest).reviewReady).toBe(false);
    }
  });

  it('requires meaningful expected/actual summaries and separate recovery counts', () => {
    const manifest = completeMetadata(); manifest.rows[0].expectedOutcome = '';
    expect(validateEvidence(manifest).reviewReady).toBe(false);
    manifest.rows[0].expectedOutcome = 'Expected'; manifest.rows[0].actualOutcome = ' '.repeat(2001);
    expect(validateEvidence(manifest).reviewReady).toBe(false);
    manifest.rows[0].actualOutcome = 'Observed'; manifest.rows[12].modelInvocationCount = null;
    manifest.rows[12].canonicalEffectCount = null;
    expect(validateEvidence(manifest).errors).toContain('C13: recovery evidence must distinguish model invocations and canonical effects');
  });

  it.each([-1, 1.5, Infinity, '1', 1000001])('rejects invalid observation count %s', value => {
    const manifest = completeMetadata(); manifest.rows[0].modelInvocationCount = value as never;
    expect(validateEvidence(manifest).reviewReady).toBe(false);
  });

  it('does not call a complete manifest reviewable when proof files are absent', async () => {
    const fixture = await evidenceFixture();
    try {
      await fixture.save();
      expect(validateEvidence(fixture.manifest).reviewReady).toBe(true);
      expect(await inspectEvidenceFile(fixture.filename)).toMatchObject({ reviewReady: false, referencesChecked: false });
      await fixture.populate();
      expect(await inspectEvidenceFile(fixture.filename)).toEqual({ scope: 'metadata_review_only', reviewReady: true, referencesChecked: true, errors: [] });
    } finally { await fixture.close(); }
  });

  it.each(['empty', 'directory', 'oversized'])('refuses a %s proof file without printing its contents', async kind => {
    const fixture = await evidenceFixture();
    try {
      await fixture.populate();
      const target = join(fixture.root, 'invalid-proof');
      if (kind === 'directory') await mkdir(target);
      else await writeFile(target, kind === 'empty' ? '' : 'PRIVATE_SENTINEL'.repeat(750000));
      fixture.manifest.rows[0].evidenceRefs = ['invalid-proof']; await fixture.save();
      const result = await inspectEvidenceFile(fixture.filename);
      expect(result.reviewReady).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    } finally { await fixture.close(); }
  });

  it('rejects a directory junction/symlink that escapes the manifest evidence root', async () => {
    const fixture = await evidenceFixture();
    try {
      await fixture.populate();
      const outside = join(fixture.directory, 'outside'); await mkdir(outside);
      await writeFile(join(outside, 'private.md'), 'PRIVATE_SENTINEL');
      await symlink(outside, join(fixture.root, 'external'), 'junction');
      fixture.manifest.rows[0].evidenceRefs = ['external/private.md']; await fixture.save();
      const result = await inspectEvidenceFile(fixture.filename);
      expect(result).toMatchObject({ reviewReady: false, referencesChecked: false });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    } finally { await fixture.close(); }
  });

  it('bounds manifest reads before parsing oversized data', async () => {
    const fixture = await evidenceFixture();
    try {
      await writeFile(fixture.filename, 'PRIVATE_SENTINEL'.repeat(75000));
      const result = await inspectEvidenceFile(fixture.filename);
      expect(result).toMatchObject({ reviewReady: false, referencesChecked: false });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    } finally { await fixture.close(); }
  });

  it('rejects raw credential fields without including their key or value in diagnostics', () => {
    const manifest = { ...completeMetadata(), refreshToken: 'PRIVATE_SENTINEL' };
    const result = validateEvidence(manifest);
    expect(result.reviewReady).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('refreshToken');
  });

  it('handles malformed input and unavailable files with generic diagnostics', async () => {
    for (const input of [null, [], 'PRIVATE_SENTINEL', { rows: [null, { id: 'PRIVATE_SENTINEL' }] }]) {
      const result = validateEvidence(input);
      expect(result.reviewReady).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    }
    expect(await inspectEvidenceFile('missing-phase-c-evidence.json')).toMatchObject({ reviewReady: false });
  });
});
