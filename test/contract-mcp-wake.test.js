import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), 'utf8'));

async function load() {
  const schemas = await readJson('mcp-wake', 'schemas.json');
  const wake = await readJson('http-wake', 'schemas.json');
  const names = await readJson('envoi-names', 'schemas.json');
  const dir = path.join(root, 'mcp-wake');
  const fixtures = new Map();
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'schemas.json')) {
    const fixture = await readJson('mcp-wake', file);
    fixtures.set(fixture.id, fixture);
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schemas);
  ajv.addSchema(wake);
  const own = name => ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  const theirs = name => ajv.getSchema(`${wake.$id}#/definitions/${name}`);
  return { schemas, wake, names, fixtures, own, theirs, ajv };
}

const content = fixture => JSON.parse(fixture.response.body.result.content[0].text);
const originOf = url => new URL(url).origin;

test('mcp-wake: tool results parse to their declared envelope and reuse the http-wake subscription shape', async () => {
  const { fixtures, own, theirs, ajv } = await load();
  let checked = 0;
  for (const fixture of fixtures.values()) {
    if (!fixture.response?.toolResult) continue;
    const value = content(fixture);
    assert.equal(own(fixture.response.toolResult)(value), true, `${fixture.id}: ${ajv.errorsText(own(fixture.response.toolResult).errors)}`);
    assert.equal(fixture.response.body.result.isError, value.ok === false, `${fixture.id}: isError follows ok`);
    if (value.result?.subscription) assert.equal(theirs('subscription')(value.result.subscription), true, `${fixture.id}: ${ajv.errorsText(theirs('subscription').errors)}`);
    if (value.result?.httpWake) {
      assert.deepEqual(Object.keys(value.result.httpWake).sort(), ['available', 'subscription', 'version'], `${fixture.id}: httpWake summary fields`);
      assert.equal(value.result.httpWake.version, 1);
      assert.equal(theirs('subscriptionSummary')(value.result.httpWake.subscription), true, `${fixture.id}: summary`);
    }
    checked += 1;
  }
  assert.ok(checked >= 12);
});

test('mcp-wake: tool lists keep the 19 envoi-names tools untouched and add exactly four only with the flag', async () => {
  const { fixtures, schemas, names } = await load();
  const existing = Object.values(names['x-tool-names']);
  const off = fixtures.get('tools-list-flag-off').response.body.result.tools.map(tool => tool.name);
  const on = fixtures.get('tools-list-flag-on').response.body.result.tools.map(tool => tool.name);
  assert.deepEqual(off, existing, 'flag off: byte-for-byte the existing list');
  assert.deepEqual(on.slice(0, existing.length), existing, 'flag on: existing tools first, unchanged');
  assert.deepEqual(on.slice(existing.length), schemas['x-tools'].map(tool => tool.name));
  assert.equal(on.length, existing.length + 4);
  assert.equal(new Set(on).size, on.length, 'no duplicate names');
  for (const tool of schemas['x-tools']) {
    assert.match(tool.name, /^envoi_wake_[a-z]+$/);
    assert.equal(tool.permission, 'receive_agent_messages');
    assert.equal(tool.scope, 'envoi.agent', 'no new OAuth scope: approved agent-remote-auth x-scopes are untouched');
  }
  assert.equal(fixtures.get('tools-list-flag-off').flags.ENVOI_MCP_WAKE_V1, false);
  assert.equal(fixtures.get('tools-list-flag-on').flags.ENVOI_MCP_WAKE_V1, true);
});

test('mcp-wake: arguments are closed objects, and the destination is bound to a declared origin, never to model text', async () => {
  const { fixtures, schemas, ajv } = await load();
  const inputs = new Map(schemas['x-tools'].map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
  for (const fixture of fixtures.values()) {
    const params = fixture.request?.body?.params;
    if (!params || !inputs.has(params.name)) continue;
    const valid = inputs.get(params.name)(params.arguments);
    assert.equal(valid, fixture.id !== 'create-invalid-args', `${fixture.id}: argument validity`);
    if (params.name !== 'envoi_wake_create' || !valid) continue;
    const declared = fixture.context.wakeOrigins.includes(originOf(params.arguments.url));
    const expectsOrigin = fixture.id === 'create-origin-not-declared';
    if (fixture.context.clientKind === 'pre_registered' && !expectsOrigin) assert.ok(declared, `${fixture.id}: the URL is on a declared origin`);
    if (expectsOrigin) assert.equal(declared, false);
  }
  const rule = schemas['x-wake-origins'];
  for (const fixture of fixtures.values()) {
    const origins = fixture.context?.wakeOrigins ?? [];
    assert.ok(origins.length <= rule.maxOrigins, fixture.id);
    for (const origin of origins) assert.match(origin, /^https:\/\/[a-z0-9.-]+$/, `${fixture.id}: an https origin, no port, path or wildcard`);
  }
});

test('mcp-wake: refusals, codes and lifecycle match their tables; no REST audience exception', async () => {
  const { fixtures, schemas, wake } = await load();
  for (const fixture of fixtures.values()) {
    if (fixture.kind !== 'http' || !fixture.response) continue;
    const { response } = fixture;
    if (response.toolResult === 'toolFailureEnvelope') {
      const failure = content(fixture);
      const row = schemas['x-tool-errors'][failure.code];
      assert.ok(row, `${fixture.id}: ${failure.code} in x-tool-errors`);
      assert.equal(failure.message, row.message, fixture.id);
      assert.equal(failure.retryable, row.retryable, fixture.id);
      assert.equal(fixture.client.guidance, row.guidanceByRoute?.[fixture.context.route] ?? row.guidance, `${fixture.id}: guidance`);
      if (failure.reason) assert.ok(row.reasons?.includes(failure.reason), `${fixture.id}: reason ${failure.reason}`);
    }
    if (response.body?.code) {
      const row = schemas['x-codes'][response.body.code].bySurface.backend;
      assert.equal(response.status, schemas['x-codes'][response.body.code].status, fixture.id);
      assert.equal(fixture.client.lifecycle, row.lifecycle, fixture.id);
    }
  }
  const rest = fixtures.get('rest-route-refuses-audience-token');
  assert.equal(rest.request.path, '/api/agent/wake-subscriptions');
  assert.equal(rest.response.status, 401);
  assert.equal(rest.response.body.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(fixtures.get('create-paused').response.status, 409, 'paused is HTTP 409, never a JSON-RPC result');
  for (const reason of schemas['x-tool-errors'].WAKE_URL_REJECTED.reasons.filter(r => r !== 'origin_not_declared')) assert.ok(wake.definitions.urlRejectedReason.enum.includes(reason), `${reason} is an http-wake reason`);
  for (const id of ['status-ended-by-owner']) {
    const reason = content(fixtures.get(id)).result.httpWake.subscription.endedReason;
    assert.ok(wake.definitions.endedReason.enum.includes(reason), `${id}: ${reason}`);
  }
  assert.deepEqual(schemas['x-notification'].newFields, [], 'notification bodies are unchanged');
  assert.equal(schemas['x-flags'].ENVOI_MCP_WAKE_V1.default, false);
});
