// PowerShell: node integrations/gates/phase-c/offline/check.mjs [--kit-root ABSOLUTE_V4_ROOT]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteDigest, selected, verifySelectedKit } from './v4-glue.mjs';
import { checkOriginalAssembly } from './assembly-copy.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const refs = JSON.parse(await readFile(new URL('./production-source.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
async function checked(label, operation) {
  try { await operation(); console.log(`PASS ${label}`); }
  catch (error) { throw new Error(`FAIL ${label}: ${error.message}`, { cause: error }); }
}
async function sourcePins() {
  for (const entry of refs.files) {
    const base = entry.path.startsWith('src/') && process.env.ENVOI_OFFLINE_SERVER_ROOT || root;
    const text = (await readFile(path.join(base, entry.path), 'utf8')).replaceAll('\r\n', '\n');
    const approved = [entry.sha256, ...(entry.compatibleSources || []).map(reference => reference.sha256)];
    assert(approved.includes(byteDigest(text)), `SOURCE_CHANGED ${entry.path}: review compatibility and refresh the selected pin; do not bypass`);
  }
  for (const [name, entry] of Object.entries(selected.segments)) assert.equal(byteDigest(entry.source), entry.sha256, `V4_EXCERPT_CHANGED ${name}`);
}
async function suite(config, files) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=2', '--reporter=verbose', ...files],
    { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, `TEST_FAILURE: rerun the named failing test from PowerShell; preserve its initiating error`);
}
try {
  assert(args.length === 0 || args.length === 2 && args[0] === '--kit-root', 'USAGE: node integrations/gates/phase-c/offline/check.mjs [--kit-root ABSOLUTE_V4_ROOT]');
  await checked('selected SDK/server implementation pins and v4 public excerpts', sourcePins);
  if (args.length) {
    await checked('selected assembled v4 packet, package and operator bytes (read only)', () => verifySelectedKit(args[1]));
    await checked('original assembled v4 suite: 65 tests on disposable copies, transport blocked', () => checkOriginalAssembly(args[1]));
  }
  else console.log('INFO kit parity NOT RUN: using committed public v4 excerpts; add --kit-root to verify the sealed assembly');
  await checked('eight incident regressions and existing runtime/control boundaries', () => suite('integrations/vitest.config.ts', [
    'integrations/gates/phase-c/offline/sdk-compatibility.test.ts', 'integrations/gates/phase-c/offline/server-compatibility.test.ts',
    'integrations/hermes/scoped-runtime.test.ts', 'integrations/hermes/continuation-receiver.test.ts',
    'integrations/hermes/continuation-receiver-batch.test.ts', 'integrations/hermes/reselect.test.ts'
  ]));
  await checked('existing SDK parsing, cancellation, initiating failure and cleanup regressions', () => suite('vitest.sdk.config.ts', [
    'sdk/typescript/test/case-session.test.ts', 'sdk/typescript/test/case-session-work.test.ts'
  ]));
  console.log('PASS offline harness compatibility only. Phase C live acceptance remains incomplete.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
