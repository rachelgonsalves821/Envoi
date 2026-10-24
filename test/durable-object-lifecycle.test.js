import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContainerLifecycle } from '../scripts/check-deployment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => ({
  exports: { SinaloaContainer: { type: 'durable-object', storage: 'sqlite' } },
  durable_objects: { bindings: [{ name: 'SINALOA_CONTAINER', class_name: 'SinaloaContainer' }] },
  containers: [{ class_name: 'SinaloaContainer' }]
});

test('ordinary deployment guard refuses destructive lifecycle or binding drift', () => {
  assert.doesNotThrow(() => validateContainerLifecycle(fixture(), 'SinaloaContainer', 'SINALOA_CONTAINER'));
  for (const mutate of [
    c => { c.migrations = []; },
    c => { c.migrations = [{ tag: 'v1', new_sqlite_classes: ['SinaloaContainer'] }]; },
    c => { delete c.exports; },
    c => { c.exports.SinaloaContainer = { type: 'durable-object', state: 'deleted' }; },
    c => { c.exports.SinaloaContainer.state = 'renamed'; c.exports.SinaloaContainer.renamed_to = 'Replacement'; },
    c => { c.exports.SinaloaContainer.state = 'transferred'; c.exports.SinaloaContainer.transferred_to = 'another-worker'; },
    c => { c.exports.SinaloaContainer.state = 'expecting-transfer'; c.exports.SinaloaContainer.transfer_from = 'another-worker'; },
    c => { c.exports.SinaloaContainer.storage = 'legacy-kv'; },
    c => { c.exports.Replacement = c.exports.SinaloaContainer; delete c.exports.SinaloaContainer; },
    c => { c.exports.Extra = { type: 'durable-object', storage: 'sqlite' }; },
    c => { c.durable_objects.bindings[0].script_name = 'another-worker'; },
    c => { c.durable_objects.bindings[0].name = 'REPLACEMENT'; },
    c => { c.durable_objects.bindings[0].class_name = 'Replacement'; },
    c => { c.containers[0].class_name = 'Replacement'; }
  ]) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => validateContainerLifecycle(changed, 'SinaloaContainer', 'SINALOA_CONTAINER'));
  }
});

// Use the actual installed Wrangler serializer, rather than copying its
// migration-tag logic. --dry-run writes a local upload file and cannot deploy;
// credentials are fake and the API origin is an unreachable loopback port.
for (const [name, args, className, bindingName] of [
  ['app staging', ['--env', 'staging'], 'SinaloaContainer', 'SINALOA_CONTAINER'],
  ['app beta', ['--env', 'beta'], 'SinaloaContainer', 'SINALOA_CONTAINER'],
  ['scanner staging', ['--config', 'scanner/wrangler.jsonc'], 'ClamAVContainer', 'CLAMAV_CONTAINER'],
  ['scanner beta', ['--config', 'scanner/wrangler.beta.jsonc'], 'ClamAVContainer', 'CLAMAV_CONTAINER']
]) test(`${name} serialized upload uses declarative SQLite exports, never migration tags`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'envoi-lifecycle-'));
  try {
    const outfile = join(temporary, 'worker-upload');
    const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_API_TOKEN: 'offline-fixture-unused', CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
      XDG_CONFIG_HOME: join(temporary, 'auth') };
    for (const key of ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_KEY', 'CF_EMAIL', 'CF_API_TOKEN', 'WRANGLER_PROFILE']) delete env[key];
    execFileSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy', ...args, '--dry-run', '--containers-rollout=none', '--outfile', outfile],
    { cwd: root, env, timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const bytes = await readFile(outfile);
    const firstLine = bytes.subarray(0, bytes.indexOf('\r\n')).toString();
    assert.ok(firstLine.startsWith('--'), 'Wrangler wrote its multipart upload');
    const form = await new Response(bytes, { headers: { 'content-type': `multipart/form-data; boundary=${firstLine.slice(2)}` } }).formData();
    const part = form.get('metadata');
    const metadata = JSON.parse(typeof part === 'string' ? part : await part.text());
    assert.equal(Object.hasOwn(metadata, 'migrations'), false, 'No old_tag/new_tag/bootstrap steps may be submitted');
    assert.ok(metadata.exports, 'Wrangler must submit the existing declarative class');
    assert.deepEqual(Object.keys(metadata.exports), [className]);
    assert.equal(metadata.exports[className].type, 'durable-object');
    assert.equal(metadata.exports[className].storage, 'sqlite');
    assert.equal(metadata.exports[className].state ?? 'created', 'created');
    for (const key of ['renamed_to', 'transferred_to', 'transfer_from']) assert.equal(Object.hasOwn(metadata.exports[className], key), false);
    assert.ok(metadata.bindings.some(b => b.name === bindingName && b.class_name === className && !b.script_name));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
