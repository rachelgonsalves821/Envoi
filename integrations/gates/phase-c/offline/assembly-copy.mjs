import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteDigest } from './v4-glue.mjs';

const manifest = JSON.parse(await readFile(new URL('./assembly-source.json', import.meta.url), 'utf8'));
const within = (root, relative) => {
  const result = path.resolve(root, relative), tail = path.relative(root, result);
  assert(tail && !path.isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + path.sep), 'ASSEMBLY_PATH_OUTSIDE_COPY_ROOT');
  return result;
};

export async function withAssemblyCleanup(operation, cleanup) {
  let initiating;
  try { return await operation(); }
  catch (error) { initiating = error; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      if (initiating) throw new AggregateError([initiating, error], initiating.message, { cause: initiating });
      throw error;
    }
  }
}

/** Copy only pinned test dependencies, never enumerate/copy the live operator kit. */
export async function checkOriginalAssembly(kitRoot) {
  const sourceRoot = await realpath(path.resolve(kitRoot, '../..'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'envoi-offline-assembly-'));
  return withAssemblyCleanup(async () => {
    const sourceText = [];
    const copyOne = async entry => {
      const source = within(sourceRoot, entry.path), stat = await lstat(source);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 10000000, `ASSEMBLY_INPUT_INVALID: ${entry.path}`);
      within(sourceRoot, path.relative(sourceRoot, await realpath(source)));
      const bytes = await readFile(source);
      assert.equal(byteDigest(bytes), entry.sha256, `ASSEMBLY_INPUT_CHANGED: ${entry.path}; review a fresh assembly before retrying`);
      const target = within(scratch, entry.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      return bytes.toString('utf8');
    };
    for (const entry of manifest.files) sourceText.push(await copyOne(entry));
    // Locate support inputs only in the exact hash-pinned original code. Their
    // historical identifiers and contents never enter this public manifest.
    const patterns = {
      terminalBudget: /minimal-staging-release-[^/'"\s]+\/budget-[^/'"\s]+\.terminal-[^/'"\s]+\.json/g,
      inventorySql: /PHASE-C-\d+-RESUME-READONLY\.sql/g,
      humanRefreshProof: /phase-c-\d+-human-refresh-proof\.json/g
    };
    const terminalPaths = [...new Set(sourceText.join('\n').match(patterns.terminalBudget) || [])];
    assert.equal(terminalPaths.length, 1, 'PRIVATE_ASSEMBLY_TERMINAL_INPUT_AMBIGUOUS');
    for (const input of manifest.privateInputs) {
      const paths = [...new Set(sourceText.join('\n').match(patterns[input.kind]) || [])];
      assert.equal(paths.length, 1, `PRIVATE_ASSEMBLY_INPUT_AMBIGUOUS: ${input.kind}`);
      const selectedPath = input.kind === 'terminalBudget' ? paths[0] : path.posix.join(path.posix.dirname(terminalPaths[0]), paths[0]);
      await copyOne({ path: selectedPath, sha256: input.sha256 });
    }
    await writeFile(path.join(scratch, 'package.json'), '{"type":"module"}', { flag: 'wx', mode: 0o600 });
    const temporary = path.join(scratch, 'test-temp');
    await mkdir(temporary, { mode: 0o700 });
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'USER', 'USERNAME']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(environment, { TMP: temporary, TEMP: temporary, TMPDIR: temporary, ENVOI_MONAD_PERMISSIONS: 'false' });
    const child = spawn(process.execPath, ['--import', new URL('./transport-guard.mjs', import.meta.url).href,
      '--test', '--test-concurrency=1', ...manifest.tests.map(file => within(scratch, file))], {
      cwd: within(scratch, path.relative(sourceRoot, kitRoot)), windowsHide: true,
      env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL'
    });
    let transcript = '';
    child.stdout.on('data', chunk => { transcript += chunk; });
    child.stderr.on('data', chunk => { transcript += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) {
      // Original assertions can contain historical values. Preserve diagnostics
      // privately outside the repository; never echo them into CI or commits.
      const report = await mkdtemp(path.join(tmpdir(), 'envoi-offline-private-report-'));
      await writeFile(path.join(report, 'original-tests.log'), transcript, { mode: 0o600 });
      throw new Error(`ORIGINAL_ASSEMBLY_TEST_FAILED: private transcript ${path.join(report, 'original-tests.log')}; originals unchanged`);
    }
    const failed = transcript.match(/(?:# |ℹ )fail (\d+)/)?.[1];
    const passed = transcript.match(/(?:# |ℹ )pass (\d+)/)?.[1];
    assert.equal(failed, '0', 'ORIGINAL_ASSEMBLY_FAILURE_SUMMARY_MISSING');
    const skipped = transcript.match(/(?:# |ℹ )skipped (\d+)/)?.[1];
    const expectedSkipped = process.platform === 'win32' ? 0 : 3; // Existing Windows-only original tests, unchanged.
    assert.equal(Number(skipped), expectedSkipped, 'ORIGINAL_ASSEMBLY_SKIP_COUNT_CHANGED');
    assert.equal(Number(passed), 65 - expectedSkipped, 'ORIGINAL_ASSEMBLY_PASS_COUNT_CHANGED');
    return { passed: Number(passed), skipped: Number(skipped), codeFiles: manifest.codeFiles, transport: 'blocked', originalFilesChanged: false };
  }, async () => {
    // scratch is a fresh, absolute mkdtemp root; no packet path can select it.
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}
