import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentMcpTools } from '../src/agent-mcp.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), 'utf8'));
async function load() {
  const schemas = await readJson('provider-connector-tools', 'schemas.json');
  const remote = await readJson('agent-remote-auth', 'schemas.json');
  const fixtures = new Map();
  for (const file of (await readdir(path.join(root, 'provider-connector-tools'))).filter(name => name.endsWith('.json') && name !== 'schemas.json')) {
    const fixture = await readJson('provider-connector-tools', file);
    fixtures.set(fixture.id, fixture);
  }
  return { schemas, remote, fixtures };
}
const has = (permissions, permission) => permission === null || (permission === 'read' ? permissions.some(p => p === 'send_agent_messages' || p === 'receive_agent_messages') : permissions.includes(permission));

test('provider-connector-tools: the classification is exactly the live /mcp tool table, in order, with the live permission', async () => {
  const { schemas } = await load();
  assert.deepEqual(schemas['x-tool-classification'].map(row => row.name), agentMcpTools.map(tool => tool.name), 'a tool added to or removed from /mcp needs a new revision of this table');
  for (const [index, row] of schemas['x-tool-classification'].entries()) {
    const tool = agentMcpTools[index];
    assert.equal(row.permission, tool.permission, `${row.name}: permission`);
    assert.equal(row.idempotencyKeyRequired, tool.inputSchema.required?.includes('idempotencyKey') ?? false, `${row.name}: idempotency key`);
    assert.equal(row.leaseFenced, Boolean(tool.inputSchema.properties?.leaseToken), `${row.name}: lease fence follows the schema`);
  }
});

test('provider-connector-tools: effect classes follow permission and side effect, and no outward effect is called a read', async () => {
  const { schemas, remote } = await load();
  const classes = Object.keys(schemas['x-effect-classes']);
  const scopes = new Map(remote['x-scopes'].map(row => [row.permission, row.scope]));
  for (const row of schemas['x-tool-classification']) {
    assert.ok(classes.includes(row.effect), row.name);
    if (row.permission === 'send_agent_messages') { assert.equal(row.effect, 'sensitive_write', row.name); assert.equal(row.outwardEffect, true); assert.equal(scopes.get('send_agent_messages'), 'envoi.send'); }
    if (row.outwardEffect) { assert.equal(row.effect, 'sensitive_write', `${row.name}: outward effects are sensitive writes`); assert.equal(row.proposedPerUseProviderApproval, true, row.name); }
    if (row.effect === 'read') { assert.equal(row.stateChange, 'none', `${row.name}: a read changes nothing`); assert.equal(row.outwardEffect, false); }
    if (/_work$/.test(row.name)) assert.equal(row.effect, 'write', `${row.name}: work state is a write, never an inbox read`);
  }
  assert.ok(schemas['x-tool-classification'].some(row => row.name === 'envoi_claim_work' && row.scope === 'envoi.agent'), 'claim authority is inside the required scope');
});

test('provider-connector-tools: visible tool lists, the minimum set and the read-only decision are explicit', async () => {
  const { schemas, fixtures } = await load();
  for (const [key, list] of Object.entries(schemas['x-visible-by-permission'])) {
    const permissions = key.split('+');
    assert.deepEqual(list, agentMcpTools.filter(tool => has(permissions, tool.permission)).map(tool => tool.name), key);
  }
  assert.deepEqual(fixtures.get('tools-list-envoi-agent-only').response.body.result.tools.map(t => t.name), schemas['x-visible-by-permission'].receive_agent_messages);
  assert.deepEqual(fixtures.get('tools-list-envoi-agent-and-send').response.body.result.tools.map(t => t.name), schemas['x-visible-by-permission']['receive_agent_messages+send_agent_messages']);
  assert.ok(!schemas['x-visible-by-permission'].receive_agent_messages.some(name => /send|start_case/.test(name)), 'envoi.agent alone cannot send');
  const minimum = schemas['x-minimum-submission-set'];
  const names = agentMcpTools.map(tool => tool.name);
  assert.ok(minimum.tools.every(name => names.includes(name)));
  for (const excluded of minimum.excluded) { assert.ok(names.includes(excluded)); assert.ok(!minimum.tools.includes(excluded), excluded); }
  assert.equal(minimum.tools.length + minimum.excluded.length, names.length, 'every tool is in or out of the minimum set');
  assert.ok(minimum.tools.includes('envoi_send_message') && !minimum.tools.includes('envoi_start_case'), 'reply to the current case only, no arbitrary new case');
  assert.match(schemas['x-rules'].R6, /must not be described/);
  assert.deepEqual(Object.keys(schemas['x-read-only-options']).sort(), ['A', 'B', 'C']);
});

test('provider-connector-tools: provider approval is never an argument, and refusals match the approved behaviour', async () => {
  const { schemas, fixtures } = await load();
  const send = fixtures.get('send-provider-approval-field-refused');
  assert.equal(send.request.body.params.arguments.providerApproved, true);
  assert.equal(send.response.body.error.code, -32602);
  const live = agentMcpTools.find(tool => tool.name === 'envoi_send_message');
  assert.equal(live.inputSchema.additionalProperties, false, 'the live schema is closed');
  assert.ok(!('providerApproved' in live.inputSchema.properties));
  const scope = fixtures.get('send-without-send-scope');
  assert.equal(scope.response.status, 403);
  assert.match(scope.response.headers['www-authenticate'], /scope="envoi\.send"/);
  assert.equal(fixtures.get('claim-tools-need-lease-fence').response.body.error.message, 'Invalid tool arguments');
  assert.deepEqual(fixtures.get('muse-evidence-gates').evidence.unproven.map(item => item.gate).sort(), [...schemas['x-evidence-gates']].sort());
});
