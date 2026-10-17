import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientSurfaces, inspectSourceReadiness, requiredContracts } from './source-readiness.mjs';

const temporaryRoots: string[] = [];

async function sourceFixture(contracts: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-phase-c-source-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'test/contract-fixtures'), { recursive: true });
  await writeFile(path.join(root, 'test/contract-fixtures/index.json'), JSON.stringify({ version: 1, contracts }));
  for (const relativePath of clientSurfaces) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), 'private fixture source');
  }
  return root;
}

const publishedContracts = () => requiredContracts.map(id => ({ id, version: 1, status: 'published', fixtures: ['example.json'] }));

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Phase C source inventory', () => {
  it('fingerprints real client surfaces in this checkout', async () => {
    const report = await inspectSourceReadiness(fileURLToPath(new URL('../../../', import.meta.url)));
    expect(report.surfaces).toHaveLength(clientSurfaces.length);
    expect(report.surfaces.every(surface => /^[a-f0-9]{64}$/.test(surface.sha256 ?? ''))).toBe(true);
  });

  it('blocks when only existing Phase A/B contracts are registered', async () => {
    const root = await sourceFixture([{ id: 'agent-registration', version: 1, status: 'approved', fixtures: ['example.json'] }]);
    const report = await inspectSourceReadiness(root);
    expect(report.status).toBe('blocked');
    expect(report.contracts).toEqual(requiredContracts.map(id => ({ id, status: 'missing' })));
  });

  it('never treats a published or approved registry entry as client approval or a hosted pass', async () => {
    for (const status of ['published', 'approved']) {
      const root = await sourceFixture(publishedContracts().map(contract => ({ ...contract, status })));
      const report = await inspectSourceReadiness(root);
      expect(report.status).toBe('review_required');
      expect(report.scope).toBe('local_source_inventory_only');
      expect(report.contracts.every(contract => contract.status === 'requires_contract_review')).toBe(true);
    }
  });

  it('blocks duplicate, unpublished and malformed required contract metadata', async () => {
    for (const replacement of [
      [...publishedContracts(), publishedContracts()[0]],
      publishedContracts().map(contract => ({ ...contract, status: 'draft' })),
      publishedContracts().map(contract => ({ ...contract, version: 0 })),
      publishedContracts().map(contract => ({ ...contract, fixtures: [] }))
    ]) {
      const root = await sourceFixture(replacement);
      expect((await inspectSourceReadiness(root)).status).toBe('blocked');
    }
  });

  it('detects source drift without exposing source contents or arbitrary registry fields', async () => {
    const root = await sourceFixture(publishedContracts().map(contract => ({ ...contract, token: 'SECRET_FIXTURE_SENTINEL' })));
    const before = await inspectSourceReadiness(root);
    await writeFile(path.join(root, clientSurfaces[0]), 'changed source');
    const after = await inspectSourceReadiness(root);
    expect(before.surfaces[0].sha256).not.toBe(after.surfaces[0].sha256);
    expect(JSON.stringify(before)).not.toContain('private fixture source');
    expect(JSON.stringify(before)).not.toContain('SECRET_FIXTURE_SENTINEL');
  });

  it('reports unreadable source dependencies and invalid registry without leaking file contents', async () => {
    const root = await sourceFixture(publishedContracts());
    await rm(path.join(root, clientSurfaces[0]));
    expect((await inspectSourceReadiness(root)).status).toBe('blocked');
    await writeFile(path.join(root, 'test/contract-fixtures/index.json'), 'PRIVATE_INVALID_JSON');
    expect(await inspectSourceReadiness(root)).toEqual({
      status: 'blocked', reason: 'contract_registry_unreadable', contracts: [], surfaces: []
    });
  });
});
