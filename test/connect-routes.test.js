// /claim and /connect (agent-registration v1 §3, §7; Lane B REQUEST 6226744884): both serve the
// web app shell with the usual nonce/CSP handling. The reviewed skill content under /connect/ is
// served only while the local-helper route is offered, and skill.json offers exactly what
// GET /api/onboarding/routes marks available.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './a3-harness.js';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integrations', 'onboarding', 'skill');
const on = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true' };

// A raw request, so a path is sent exactly as written (fetch would normalize "..").
const raw = (baseUrl, method, target) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(baseUrl);
  const req = http.request({ hostname, port, method, path: target }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('with the flags off: /connect is the app shell, the skill content is unpublished', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  for (const route of ['/connect', '/claim']) {
    const page = await raw(server.baseUrl, 'GET', route);
    assert.equal(page.status, 200, route);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
    assert.match(page.body, /<script nonce="/, 'the shell carries the response nonce');
    const head = await raw(server.baseUrl, 'HEAD', route);
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  }
  for (const file of ['SKILL.md', 'HEARTBEAT.md', 'skill.json']) {
    const res = await raw(server.baseUrl, 'GET', `/connect/${file}`);
    assert.equal(res.status, 404, file);
    assert.equal(JSON.parse(res.body).code, 'FEATURE_DISABLED');
  }
});

test('with the local helper offered: exact reviewed content, availability-driven manifest', { timeout: 60000 }, async t => {
  const server = await launch(on);
  t.after(() => server.stop());
  for (const [file, type] of [['SKILL.md', /^text\/markdown; charset=utf-8/], ['HEARTBEAT.md', /^text\/markdown; charset=utf-8/]]) {
    const res = await raw(server.baseUrl, 'GET', `/connect/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers['content-type'], type);
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.body, await readFile(path.join(skillDir, file), 'utf8'), `${file} is served unchanged`);
    const head = await raw(server.baseUrl, 'HEAD', `/connect/${file}`);
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(res.body));
  }
  const manifest = await raw(server.baseUrl, 'GET', '/connect/skill.json');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers['content-type'], /^application\/json/);
  const served = JSON.parse(manifest.body);
  const source = JSON.parse(await readFile(path.join(skillDir, 'skill.json'), 'utf8'));
  assert.deepEqual(served.offeredConnectionRoutes, ['local_helper']);
  assert.deepEqual(served.offeredDeliveryModes, ['envoi_link']);
  const { offeredConnectionRoutes: _a, offeredDeliveryModes: _b, ...rest } = served;
  const { offeredConnectionRoutes: _c, offeredDeliveryModes: _d, ...expected } = source;
  assert.deepEqual(rest, expected, 'every other manifest field is the reviewed content');
  const routes = JSON.parse((await raw(server.baseUrl, 'GET', '/api/onboarding/routes')).body);
  assert.deepEqual(served.offeredConnectionRoutes, routes.routes.filter(item => item.available).map(item => item.connectionRoute));

  // Only the three files: nothing else under /connect/ is reachable.
  for (const target of ['/connect/README.md', '/connect/', '/connect/..%2f..%2fsrc%2fserver.js', '/connect/../src/server.js', '/connect/SKILL.md/']) {
    const res = await raw(server.baseUrl, 'GET', target);
    assert.notEqual(res.status, 200, target);
    assert.ok(!res.body.includes('createAgentRegistrations'), `${target} never leaks server source`);
  }
});

test('the manifest offers authenticated REST only with its own flag, in schema order', { timeout: 60000 }, async t => {
  const server = await launch({ ...on, ENVOI_AUTHENTICATED_REST_ROUTE: 'true' });
  t.after(() => server.stop());
  const served = JSON.parse((await raw(server.baseUrl, 'GET', '/connect/skill.json')).body);
  assert.deepEqual(served.offeredConnectionRoutes, ['local_helper', 'authenticated_rest']);
});
