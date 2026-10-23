import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsExecutable } from '../connector/windows';
import { artifactNames, launcherNames, sha256, verifyLauncherFiles } from './artifacts.mjs';
import { installPrivatePackage } from './install.mjs';
import { runLocalLauncher } from './launch.mjs';
import { preparePackage } from './prepare.mjs';

const directories: string[] = [];
const argumentsToForward = ['connect', 'https://fixture.invalid/', '', 'two words', 'a"b', 'a\\"b', 'trailing\\', "single'quote", 'unicode-雪', '$HOME', '%PATH%', '!literal!', '; & echo MUST_NOT_EXECUTE', '--eval', 'not JavaScript'];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('envoi-local-launchers-')) throw new Error('Unsafe fixture cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-local-launchers-'));
  directories.push(root);
  const source = path.join(root, 'source');
  const destination = path.join(root, "installed files 'quoted'");
  const caller = path.join(root, "caller files 'quoted'");
  await mkdir(source);
  await mkdir(caller);
  const artifacts: Record<string, { sha256: string; size: number }> = {};
  const helper = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),execArgv:process.execArgv,input:readFileSync(0,'utf8'),pathHash:createHash('sha256').update(process.env.PATH ?? '').digest('hex')})+'\\n');
process.stderr.write('FIXTURE_HELPER_STDERR\\n');
process.exitCode=23;
`;
  for (const name of artifactNames) {
    const bytes = Buffer.from(name === 'envoi-link.mjs' ? helper : 'export const fixtureOnly = true;\n');
    await writeFile(path.join(source, name), bytes);
    artifacts[name] = { sha256: sha256(bytes), size: bytes.length };
  }
  const bytes = Buffer.from(JSON.stringify({ version: 1, private: true, published: false, nodeMinimum: 22,
    coreContract: { id: 'agent-registration', version: 1, revision: 3, publication: '4da219e7156138c94e26b8105efe7ffe43ec6f98' }, artifacts }));
  await writeFile(path.join(source, 'private-release.json'), bytes);
  await installPrivatePackage(source, destination, sha256(bytes));
  return { root, source, destination, caller, digest: sha256(bytes) };
}

function launch(value: Awaited<ReturnType<typeof fixture>>, args = argumentsToForward) {
  return spawnSync(process.execPath, [path.join(value.destination, 'launch.mjs'), ...args],
    { cwd: value.caller, encoding: 'utf8', windowsHide: true, timeout: 15_000, input: 'fixture input' });
}

function expectForwarded(result: ReturnType<typeof launch>, caller: string) {
  expect(result.status, result.stderr).toBe(23);
  expect(result.stderr).toBe('FIXTURE_HELPER_STDERR\n');
  expect(JSON.parse(result.stdout)).toEqual({ argv: argumentsToForward, cwd: caller, execArgv: [], input: 'fixture input', pathHash: sha256(process.env.PATH ?? '') });
}

function powershell(value: Awaited<ReturnType<typeof fixture>>, setup = '') {
  const encoded = Buffer.from(JSON.stringify(argumentsToForward)).toString('base64');
  const script = `${setup}; $forwarded=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); & '${path.join(value.destination, 'envoi-link.ps1').replaceAll("'", "''")}' @forwarded; exit $LASTEXITCODE`;
  return spawnSync(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { cwd: value.caller, encoding: 'utf8', windowsHide: true, timeout: 20_000, input: 'fixture input' });
}

describe('explicit-path local launchers', () => {
  it('forwards arguments, stdin, output, working directory and exit code without PATH or installation writes', async () => {
    const value = await fixture();
    const files = await readdir(value.destination);
    const before = await Promise.all(files.map(async name => ({ name, bytes: await readFile(path.join(value.destination, name)), mode: (await stat(path.join(value.destination, name))).mode })));
    expectForwarded(launch(value), value.caller);
    expect(await readdir(value.destination)).toEqual(files);
    for (const saved of before) {
      expect(await readFile(path.join(value.destination, saved.name))).toEqual(saved.bytes);
      expect((await stat(path.join(value.destination, saved.name))).mode).toBe(saved.mode);
    }
    expect(await readdir(value.caller)).toEqual([]);
  });

  it('requires Node 22 before reading or running an installation', async () => {
    await expect(runLocalLauncher('not-an-installation', [], '20.0.0')).rejects.toThrow(/22/);
  });

  it('packages reviewed launchers rather than untrusted helper-source scripts and runs without a checkout', async () => {
    const value = await fixture();
    for (const name of launcherNames) await writeFile(path.join(value.source, name), 'UNTRUSTED_SOURCE_SCRIPT');
    const bundle = path.join(value.root, 'private bundle');
    await preparePackage(value.source, bundle, value.digest);
    for (const name of launcherNames) expect(await readFile(path.join(bundle, name))).toEqual(await readFile(path.resolve('integrations/distribution', name)));
    const destination = path.join(value.root, 'standalone install');
    const result = spawnSync(process.execPath, [path.join(bundle, 'install.mjs'), '--bundle', bundle, '--destination', destination, '--manifest-sha256', value.digest],
      { cwd: value.caller, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expectForwarded(launch({ ...value, destination }), value.caller);
  });

  it.each(['missing', 'pending', 'invalid', 'old', 'unapproved'])('does not launch with a %s completion record or leak private arguments', async kind => {
    const value = await fixture();
    const filename = path.join(value.destination, 'installation.json');
    if (kind === 'missing') await rm(filename);
    if (kind === 'pending') await rename(filename, path.join(value.destination, 'installation.pending.json'));
    if (kind === 'invalid') await writeFile(filename, '{');
    if (kind === 'old' || kind === 'unapproved') {
      const record = JSON.parse(await readFile(filename, 'utf8'));
      if (kind === 'old') delete record.launchers;
      else record.manifestSha256 = '0'.repeat(64);
      await writeFile(filename, JSON.stringify(record));
    }
    const result = launch(value, ['SECRET_DO_NOT_PRINT']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Local Envoi launch failed');
    expect(result.stderr).not.toContain('SECRET_DO_NOT_PRINT');
    expect(result.stderr).not.toContain(value.root);
  });

  it.each([...artifactNames, 'private-release.json', 'envoi-link', 'envoi-link.ps1'])('rejects changed %s bytes before running a helper', async name => {
    const value = await fixture();
    await writeFile(path.join(value.destination, name), 'CORRUPTED_FIXTURE');
    const result = launch(value);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('FIXTURE_HELPER_STDERR');
  });

  it.each(['launch.mjs', 'artifacts.mjs'])('detects accidental parseable %s drift under protected local installation trust', async name => {
    const value = await fixture();
    const filename = path.join(value.destination, name);
    await writeFile(filename, (await readFile(filename, 'utf8')) + '\n');
    expect(launch(value).status).toBe(1);
  });

  it('rejects extra launcher paths and linked launcher files', async () => {
    const value = await fixture();
    const record = JSON.parse(await readFile(path.join(value.destination, 'installation.json'), 'utf8'));
    await expect(verifyLauncherFiles(value.destination, { ...record.launchers, files: { ...record.launchers.files, '../session.json': { sha256: '0'.repeat(64), size: 1 } } })).rejects.toThrow(/record/);
    await link(path.join(value.destination, 'envoi-link.ps1'), path.join(value.root, 'shared.ps1'));
    expect(launch(value).status).toBe(1);
  });

  it.runIf(process.platform === 'win32')('runs the Windows PowerShell launcher with lossless native quoting', async () => {
    const value = await fixture();
    expectForwarded(powershell(value), value.caller);
    expect(await readdir(value.caller)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('fails safely when Node discovery fails without modifying PATH', async () => {
    const value = await fixture();
    const result = powershell(value, 'function Get-Command { throw "fixture Node unavailable" }');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('existing Node.js 22+');
    expect(result.stderr).not.toContain(value.root);
  });

  it.runIf(process.platform !== 'win32')('executes the POSIX launcher with lossless shell quoting', async () => {
    const value = await fixture();
    const result = spawnSync(path.join(value.destination, 'envoi-link'), argumentsToForward,
      { cwd: value.caller, encoding: 'utf8', timeout: 15_000, input: 'fixture input' });
    expectForwarded(result, value.caller);
    expect(await readdir(value.caller)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('reports missing Node without modifying PATH or invoking a helper', async () => {
    const value = await fixture();
    const result = spawnSync('/bin/sh', ['-c', 'command() { return 1; }; . "$1"', 'fixture', path.join(value.destination, 'envoi-link')],
      { cwd: value.caller, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Node.js 22');
  });
});
