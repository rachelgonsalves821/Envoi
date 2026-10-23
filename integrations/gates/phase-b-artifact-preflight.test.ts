import { describe, expect, it } from 'vitest';
import { artifactMatches, manifestMatches, originOf, releaseMatches, sha256 } from './phase-b-artifact-preflight.mjs';

describe('hosted Phase B artifact preflight', () => {
  it('accepts only a bare HTTPS release origin', () => {
    expect(originOf('https://staging.example.test/')).toBe('https://staging.example.test');
    for (const value of ['http://staging.example.test', 'https://user:pass@staging.example.test/',
      'https://staging.example.test/other', 'https://staging.example.test/?token=x',
      'https://staging.example.test/#fragment']) expect(() => originOf(value)).toThrow();
  });

  it('requires the exact release and critical readiness checks', () => {
    const sha = 'a'.repeat(40);
    const health = { ok: true, configurationValidated: true, releaseSha: sha };
    const ready = { ready: true, releaseSha: sha, checks: {
      database: { ready: true }, objectStorageReadAccess: { ready: true }, malwareScanner: { ready: true }
    } };
    expect(releaseMatches(health, ready, sha)).toBe(true);
    expect(releaseMatches(health, { ...ready, releaseSha: 'b'.repeat(40) }, sha)).toBe(false);
    expect(releaseMatches(health, { ...ready, checks: { ...ready.checks, database: { ready: false } } }, sha)).toBe(false);
  });

  it('rejects altered served or installed bytes and forged manifest sizes', () => {
    const bytes = Buffer.from('selected artifact');
    const entry = { sha256: sha256(bytes), size: bytes.length };
    expect(artifactMatches(entry, bytes, bytes, bytes)).toBe(true);
    expect(artifactMatches(entry, bytes, bytes, Buffer.from('other artifact'))).toBe(false);
    expect(artifactMatches({ ...entry, size: entry.size + 1 }, bytes, bytes, bytes)).toBe(false);
    expect(artifactMatches({ ...entry, sha256: 'x'.repeat(64) }, bytes, bytes, bytes)).toBe(false);
  });

  it('requires both host downloads in the same release manifest', () => {
    const entry = { sha256: 'a'.repeat(64), size: 10 };
    const manifest = { version: 1, runtimes: ['hermes', 'openclaw'], artifacts: {
      'envoi-connector.mjs': entry, 'envoi-openclaw.mjs': entry
    } };
    expect(manifestMatches(manifest, manifest)).toBe(true);
    expect(manifestMatches(manifest, { ...manifest, artifacts: { ...manifest.artifacts,
      'envoi-openclaw.mjs': { ...entry, sha256: 'b'.repeat(64) } } })).toBe(false);
    expect(manifestMatches(manifest, { ...manifest, runtimes: ['hermes'] })).toBe(false);
  });
});
