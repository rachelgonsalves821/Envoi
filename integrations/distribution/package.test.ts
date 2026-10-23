import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactNames, assertNode, optionsFrom, sha256 } from './artifacts.mjs';
import { preparePackage } from './prepare.mjs';
import { installPrivatePackage } from './install.mjs';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-distribution-'));
  directories.push(root);
  const source = path.join(root, 'source');
  await mkdir(source);
  const artifacts: Record<string, { sha256: string; size: number }> = {};
  for (const name of artifactNames) {
    const bytes = Buffer.from('export const fixtureOnly = true;\n');
    await writeFile(path.join(source, name), bytes);
    artifacts[name] = { sha256: sha256(bytes), size: bytes.length };
  }
  const manifest = { version: 1, private: true, published: false, nodeMinimum: 22,
    coreContract: { id: 'agent-registration', version: 1, revision: 3, publication: '4da219e7156138c94e26b8105efe7ffe43ec6f98' }, artifacts };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(source, 'private-release.json'), bytes);
  return { root, source, manifest, digest: sha256(bytes) };
}

describe('private distribution preparation', () => {
  it('copies only the two approved artifacts and known installer sources', async () => {
    const fixturePackage = await fixture();
    await writeFile(path.join(fixturePackage.source, 'session.json'), 'DO_NOT_PACKAGE_PRIVATE_STATE');
    const output = path.join(fixturePackage.root, 'bundle');
    expect(await preparePackage(fixturePackage.source, output, fixturePackage.digest)).toEqual({ state: 'private_package_prepared', published: false, manifestSha256: fixturePackage.digest, artifactCount: 2 });
    for (const name of artifactNames) expect(await readFile(path.join(output, name))).toEqual(await readFile(path.join(fixturePackage.source, name)));
    await expect(readFile(path.join(output, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(output, 'private-release.json'))).toEqual(await readFile(path.join(fixturePackage.source, 'private-release.json')));
  });

  it('preserves and verifies the REST host emitted by the combined helper build', async () => {
    const value = await fixture();
    const rest = Buffer.from('export const syntheticRestHost = true;\n');
    await writeFile(path.join(value.source, 'envoi-rest-host.mjs'), rest);
    value.manifest.artifacts['envoi-rest-host.mjs'] = { sha256: sha256(rest), size: rest.length };
    const manifest = Buffer.from(JSON.stringify(value.manifest));
    await writeFile(path.join(value.source, 'private-release.json'), manifest);
    const digest = sha256(manifest);
    const bundle = path.join(value.root, 'bundle');
    expect(await preparePackage(value.source, bundle, digest)).toMatchObject({ artifactCount: 3 });
    const installed = path.join(value.root, 'installed');
    await installPrivatePackage(bundle, installed, digest);
    expect(await readFile(path.join(installed, 'envoi-rest-host.mjs'))).toEqual(rest);
    await writeFile(path.join(bundle, 'envoi-rest-host.mjs'), 'tampered');
    const rejected = path.join(value.root, 'rejected');
    await expect(installPrivatePackage(bundle, rejected, digest)).rejects.toThrow(/checksum/);
    await expect(readFile(path.join(rejected, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs files into a new directory without connecting or replacing saved state', async () => {
    const fixturePackage = await fixture();
    const target = path.join(fixturePackage.root, 'installation');
    expect(await installPrivatePackage(fixturePackage.source, target, fixturePackage.digest)).toMatchObject({ connected: false, serviceInstalled: false });
    await writeFile(path.join(target, 'session.json'), 'EXISTING_STATE');
    await expect(installPrivatePackage(fixturePackage.source, target, fixturePackage.digest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(target, 'session.json'), 'utf8')).toBe('EXISTING_STATE');
    expect(JSON.parse(await readFile(path.join(target, 'installation.json'), 'utf8')).manifestSha256).toBe(fixturePackage.digest);
  });

  it('rejects an unpinned manifest and a changed artifact before creating destination files', async () => {
    const fixturePackage = await fixture();
    const target = path.join(fixturePackage.root, 'target');
    await expect(installPrivatePackage(fixturePackage.source, target, '0'.repeat(64))).rejects.toThrow(/checksum/);
    await writeFile(path.join(fixturePackage.source, 'envoi-link.mjs'), 'tampered');
    await expect(installPrivatePackage(fixturePackage.source, target, fixturePackage.digest)).rejects.toThrow(/checksum/);
    await expect(readFile(path.join(target, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a manifest that attempts to package credentials or escape the package', async () => {
    const fixturePackage = await fixture();
    fixturePackage.manifest.artifacts['../session.json'] = { size: 1, sha256: '0'.repeat(64) };
    const bytes = Buffer.from(JSON.stringify(fixturePackage.manifest));
    await writeFile(path.join(fixturePackage.source, 'private-release.json'), bytes);
    await expect(preparePackage(fixturePackage.source, path.join(fixturePackage.root, 'output'), sha256(bytes))).rejects.toThrow(/manifest/);
  });

  it('rejects public or incompatible manifests even with the matching checksum', async () => {
    const fixturePackage = await fixture();
    fixturePackage.manifest.published = true;
    const bytes = Buffer.from(JSON.stringify(fixturePackage.manifest));
    await writeFile(path.join(fixturePackage.source, 'private-release.json'), bytes);
    await expect(preparePackage(fixturePackage.source, path.join(fixturePackage.root, 'output'), sha256(bytes))).rejects.toThrow(/manifest/);
  });

  it('rejects a linked package directory', async () => {
    const fixturePackage = await fixture();
    const link = path.join(fixturePackage.root, 'linked');
    await symlink(fixturePackage.source, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installPrivatePackage(link, path.join(fixturePackage.root, 'output'), fixturePackage.digest)).rejects.toThrow(/symbolic links/);
  });

  it('rejects an artifact shared with another hard-linked filename', async () => {
    const fixturePackage = await fixture();
    await link(path.join(fixturePackage.source, 'envoi-link.mjs'), path.join(fixturePackage.root, 'shared-helper.mjs'));
    await expect(installPrivatePackage(fixturePackage.source, path.join(fixturePackage.root, 'output'), fixturePackage.digest)).rejects.toThrow(/unsafe/);
  });

  it('runs the installer entry with spaced arguments and preserves artifact bytes', async () => {
    const fixturePackage = await fixture();
    const destination = path.join(fixturePackage.root, 'installed files with spaces');
    const result = spawnSync(process.execPath, [path.resolve('integrations/distribution/install.mjs'), '--bundle', fixturePackage.source,
      '--destination', destination, '--manifest-sha256', fixturePackage.digest], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'private_files_installed', connected: false, serviceInstalled: false });
    expect(await readFile(path.join(destination, 'envoi-link.mjs'))).toEqual(await readFile(path.join(fixturePackage.source, 'envoi-link.mjs')));
  });

  it('keeps errors free of raw arguments, private paths and simulated credentials', () => {
    const result = spawnSync(process.execPath, [path.resolve('integrations/distribution/install.mjs'), '--token', 'SECRET_DO_NOT_PRINT'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Private installation failed');
    expect(result.stderr + result.stdout).not.toContain('SECRET_DO_NOT_PRINT');
    expect(result.stderr + result.stdout).not.toContain(process.cwd());
  });

  it('requires Node 22 and rejects duplicate, unknown and incomplete options', () => {
    expect(() => assertNode('20.0.0')).toThrow(/22/);
    expect(() => assertNode('unknown')).toThrow(/22/);
    expect(() => assertNode('22.0.0')).not.toThrow();
    expect(() => optionsFrom(['--bundle', 'first', '--bundle', 'second'], ['--bundle'])).toThrow();
    expect(() => optionsFrom(['--bundle'], ['--bundle'])).toThrow();
    expect(() => optionsFrom(['--token', 'value'], ['--bundle'])).toThrow();
    expect(() => optionsFrom(['--bundle', 'value\nextra'], ['--bundle'])).toThrow();
  });
});
