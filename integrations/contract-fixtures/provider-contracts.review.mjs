/** Offline Lane B consumption of published contracts. Reads canonical Git objects; no fixture copies or network. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const BASE = 'd05498d8dc13c6f07dc151da7a41a1619ff62436';
export const publications = [
  { pr: 215, id: 'mcp-wake', sha: '32975892945718296a4968a3d6ddbc40ef6d175b', count: 22 },
  { pr: 216, id: 'provider-event-wake', sha: '3e1574f828868be63257c6bfaf62b5e7682db249', count: 38 },
  { pr: 217, id: 'provider-gateway-native', sha: '9b13fa3cb44c68e15d7bb1d70c8c5fe1fdd15e95', count: 30 },
  { pr: 218, id: 'provider-connector-tools', sha: '3af8669a907c316b95ff92fa7031a50a654e1a18', count: 6 }
];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 12e6, windowsHide: true }).trim();
const bytes = (sha, file) => execFileSync('git', ['show', `${sha}:${file}`], { maxBuffer: 12e6, windowsHide: true });
const json = (sha, file) => JSON.parse(bytes(sha, file));
const checks = [], findings = [];
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in contract review'); };
function check(label, fn) { try { fn(); checks.push({ label, ok: true }); } catch (error) { checks.push({ label, ok: false, error: error.message }); } }
function finding(pr, id, expected, observed) { findings.push({ pr, id, expected, observed }); }
const loaded = publications.map(p => {
  const root = `test/contract-fixtures/${p.id}/`;
  const files = git('ls-tree', '--name-only', p.sha, root).split('\n').filter(f => f.endsWith('.json'));
  const schema = json(p.sha, root + 'schemas.json');
  const fixtures = files.filter(f => !f.endsWith('schemas.json')).map(f => json(p.sha, f));
  const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv); ajv.addSchema(schema);
  const def = name => { const v = ajv.getSchema(`${schema.$id}#/definitions/${name}`); assert.ok(v, `${p.id}: definition ${name}`); return v; };
  const f = id => { const value = fixtures.find(f => f.id === id); assert.ok(value, `${p.id}: fixture ${id}`); return value; };
  return { ...p, root, files, schema, fixtures, ajv, def, f };
});
for (const c of loaded) {
  check(`${c.id}: exact published fixture inventory and approved-source preservation`, () => {
    assert.equal(c.fixtures.length, c.count);
    assert.equal(new Set(c.fixtures.map(f => f.id)).size, c.count);
    const names = git('diff', '--name-only', BASE, c.sha).split('\n');
    assert.ok(names.every(n => n === 'docs/architecture/agent-native-v2/handoffs.md' || n === 'test/contract-fixtures/index.json' || n.startsWith(c.root) || n === `test/contract-${c.id}.test.js`), 'contract-only paths');
    assert.equal(git('diff', BASE, c.sha, '--', 'src', 'db', 'worker', 'wrangler.jsonc', 'test/contract-fixtures/agent-remote-auth', 'test/contract-fixtures/provider-browser-poll', 'test/contract-fixtures/http-wake'), '');
  });
  check(`${c.id}: every fixture and named HTTP result consumes its published schema`, () => {
    for (const f of c.fixtures) {
      assert.equal(c.def('fixture')(f), true, `${f.id}: ${c.ajv.errorsText(c.def('fixture').errors)}`);
      if (f.response) assert.equal(c.def(f.response.schema)(f.response.body), true, `${f.id}: response ${f.response.schema}`);
    }
  });
}
const wake = loaded[0], events = loaded[1], gateway = loaded[2], tools = loaded[3];
check('mcp-wake: Lane B request builders are closed and preserve family-derived binding', () => {
  for (const tool of wake.schema['x-tools']) {
    const validate = wake.ajv.compile(tool.inputSchema);
    const fixture = wake.fixtures.find(f => f.request?.body?.params?.name === tool.name && validate(f.request.body.params.arguments));
    assert.ok(fixture, tool.name);
    for (const key of ['ownerId', 'inboxId', 'agentId', 'installationId', 'credentialFamilyId']) {
      assert.equal(validate({ ...fixture.request.body.params.arguments, [key]: 'other_principal' }), false, `${tool.name} rejects ${key}`);
    }
    assert.equal(tool.scope, 'envoi.agent');
  }
});
check('mcp-wake: success/error and existing http-wake result decoding', () => {
  const ws = json(wake.sha, 'test/contract-fixtures/http-wake/schemas.json'); wake.ajv.addSchema(ws);
  for (const f of wake.fixtures.filter(f => f.response?.toolResult)) {
    const envelope = f.response.body.result, value = JSON.parse(envelope.content[0].text);
    assert.equal(wake.def(f.response.toolResult)(value), true, f.id);
    assert.equal(envelope.isError, value.ok === false, f.id);
    if (value.result?.subscription) assert.equal(wake.ajv.getSchema(`${ws.$id}#/definitions/subscription`)(value.result.subscription), true, f.id);
  }
  for (const [id, code] of [['create-paused','AGENT_PAUSED'],['create-revoked','CREDENTIAL_REVOKED'],['rest-route-refuses-audience-token','AUTHENTICATION_REQUIRED']]) assert.equal(wake.f(id).response.body.code, code);
  assert.equal(wake.f('create-origin-not-declared').context.wakeOrigins.includes(new URL(wake.f('create-origin-not-declared').request.body.params.arguments.url).origin), false);
  assert.equal(wake.schema['x-flags'].ENVOI_MCP_WAKE_V1.default, false);
});
check('mcp-wake: rollback is scoped to tool-created subscriptions and receiver never treats delivery as settlement', () => {
  const text = JSON.stringify(wake.f('rollback-flag-off'));
  assert.match(text, /createdVia|tool.created|MCP|mcp/);
  assert.match(text, /REST/);
  assert.match(text, /feature_disabled/);
  assert.match(JSON.stringify(wake.f('receiver-flow')), /claim|poll/);
});
check('provider-event-wake: HMAC verification and changed-byte rejection from a consumer', () => {
  const secrets = events.fixtures.filter(f => f.request?.body?.method === 'events/subscribe').map(f => f.request.body.params.delivery?.secret).filter(s => s?.startsWith('whsec_') && Buffer.from(s.slice(6),'base64').length >= 24);
  const keys = [...new Set(secrets)];
  assert.ok(keys.length >= 2);
  for (const f of events.fixtures.filter(f => f.kind === 'delivery')) {
    const { headers, bodyText } = f.delivery.request;
    const sign = body => keys.map(s => `v1,${createHmac('sha256',Buffer.from(s.slice(6),'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64')}`);
    const parts = headers['webhook-signature'].split(' ');
    assert.ok(parts.every(p => sign(bodyText).includes(p)), f.id);
    assert.ok(parts.every(p => !sign(bodyText + ' ').includes(p)), `${f.id}: exact raw bytes`);
    const body = JSON.parse(bodyText);
    if (body.type !== 'verification') {
      assert.equal(headers['webhook-id'], body.eventId ?? body.id);
      assert.doesNotMatch(bodyText, /whsec_|envoi_agent_(?:access|refresh)|envoi_case_session_|https?:\/\//);
    }
    assert.ok(Buffer.byteLength(bodyText) <= 1024);
  }
});
check('provider-event-wake: renewal, outcomes, pause/revoke and provider evidence stay bounded', () => {
  assert.equal(events.f('subscribe-created').response.body.result.id, events.f('subscribe-renewed-same-identity').response.body.result.id);
  assert.ok(events.f('subscribe-renewed-same-identity').response.body.result.refreshBefore > events.f('subscribe-created').response.body.result.refreshBefore);
  assert.equal(events.f('subscribe-replay-truncated').response.body.result.truncated, true);
  assert.equal(events.f('grok-delivery-accepted').delivery.outcome, 'accepted_receipt_only');
  assert.equal(events.f('subscribe-paused').response.body.code, 'AGENT_PAUSED');
  assert.equal(events.f('subscribe-revoked').response.body.code, 'CREDENTIAL_REVOKED');
  for (const flag of Object.values(events.schema['x-flags'])) assert.equal(flag.default, false);
  assert.match(JSON.stringify(events.f('grok-evidence-gates')), /G1/);
});
check('provider-gateway-native: consumer rejects undeclared recipient and leaked bearer/lease fields', () => {
  const act = gateway.f('reply-sent').request.body, validate = gateway.def('actRequest');
  assert.equal(validate(act), true);
  for (const key of ['recipient','agentId','installationId','leaseToken','caseSessionToken','assetUrl']) assert.equal(validate({...act,[key]:'forbidden'}),false,key);
  const result = gateway.f('claim-work').response.body;
  assert.equal(result.packet.untrusted,true);
  for (const key of ['leaseToken','accessToken','installationId']) assert.equal(gateway.def('claimResult')({...result,packet:{...result.packet,[key]:'forbidden'}}),false,key);
  assert.equal(result.packet.runId, gateway.f('claim-work').request.body.runId);
});
check('provider-gateway-native: client action boundaries, replay, owner pending, pause and revoked behavior', () => {
  assert.deepEqual(gateway.schema['x-actions'].supported,['reply','request_owner','defer']);
  const first = gateway.f('reply-sent'), replay = gateway.f('reply-replayed-same-key');
  assert.deepEqual(first.request.body, replay.request.body);
  assert.deepEqual({...replay.response.body,replayed:false},first.response.body);
  assert.equal(first.response.body.settled,true);
  for(const id of ['reply-needs-owner-approval','request-owner']){assert.equal(gateway.f(id).response.body.settled,false);assert.ok(gateway.f(id).response.body.requestRef);}
  for(const [id,code] of [['reply-after-pause','AGENT_PAUSED'],['reply-after-revoke','CREDENTIAL_REVOKED'],['reply-wrong-run','GATEWAY_RUN_MISMATCH'],['reply-lease-lost','LEASE_LOST']])assert.equal(gateway.f(id).response.body.code,code);
  assert.equal(gateway.f('scope-upgrade-from-gateway-session-denied').response.status,401);
  assert.equal(gateway.f('claim-read-only-session').response.status,403);
  assert.equal(gateway.f('scope-upgrade-owner').response.body.requiresNewSessionCookie,true);
  assert.equal(gateway.schema['x-flags'].ENVOI_PROVIDER_GATEWAY_NATIVE_V1.default,false);
});
check('provider-connector-tools: live schema classification, truthful scopes and minimum submission', () => {
  const liveSource = bytes(tools.sha,'src/agent-mcp.js').toString();
  const rows = tools.schema['x-tool-classification'];
  assert.equal(rows.length,19);
  for(const r of rows){assert.ok(liveSource.includes(r.name));if(r.outwardEffect){assert.equal(r.effect,'sensitive_write');assert.equal(r.proposedPerUseProviderApproval,true);}}
  const receive = tools.f('tools-list-envoi-agent-only').response.body.result.tools.map(t=>t.name);
  assert.ok(receive.includes('envoi_claim_work')&&receive.includes('envoi_complete_work'));
  assert.ok(!receive.includes('envoi_send_message'));
  const min=tools.schema['x-minimum-submission-set'];assert.equal(min.tools.length+min.excluded.length,19);
  assert.ok(min.tools.includes('envoi_send_message')&&!min.tools.includes('envoi_start_case'));
  assert.equal(tools.f('send-provider-approval-field-refused').response.body.error.code,-32602);
  assert.equal(tools.f('send-without-send-scope').response.status,403);
  assert.deepEqual(Object.keys(tools.schema['x-read-only-options']),['A','B','C']);
});

// Interoperability probes are observations, not weakening of the positive consumption checks.
for(const id of ['unsubscribe-ok','unsubscribe-unknown-is-idempotent']){
 const f=events.f(id);if(f.request.body.params.delivery.mode !== 'webhook')finding(216,`${id}: official unsubscribe delivery shape`,'delivery includes mode:"webhook" and the original callback URL',f.request.body.params.delivery);
}
for(const f of events.fixtures.filter(f=>f.kind==='delivery')){
 const body=JSON.parse(f.delivery.request.bodyText), occurred=Date.parse(body.timestamp??body.createdAt??'');
 const signed=Number(f.delivery.request.headers['webhook-timestamp'])*1000;
 if(Number.isFinite(occurred)&&occurred-signed>300000)finding(216,`${f.id}: signing clock`,'an accepted live delivery cannot be signed almost seven days before the event occurs',{occurred:new Date(occurred).toISOString(),signed:new Date(signed).toISOString(),differenceSeconds:(occurred-signed)/1000});
}
const eventText=bytes(events.sha,'docs/architecture/agent-native-v2/handoffs.md').toString().split('## provider-event-wake v1')[1];
if(eventText.includes('no caching in v1'))finding(216,'callback verification cache','bounded principal+callback verification cache as specified in the cited official MCP Events guide','contract requires a fresh challenge for every subscription and renewal, explicitly no caching');
const nativeText=bytes(gateway.sha,'docs/architecture/agent-native-v2/handoffs.md').toString().split('## provider-gateway-native v1')[1];
const upgrade=gateway.f('scope-upgrade-owner');
const transitions=gateway.fixtures.filter(f=>f.kind==='sequence'&&/cookie|generation|scope upgrade/i.test(JSON.stringify(f.steps)));
if(!transitions.some(f=>f.steps?.some(step=>/old.*cookie|old.*generation/i.test(step.does)) && f.steps?.some(step=>/new.*cookie|new.*session/i.test(step.does)) && f.steps?.some(step=>step.fixture === 'claim-work')))finding(217,'owner scope upgrade session handoff','an executable old-cookie refusal -> approved same-installation new-cookie acquisition -> successful native claim sequence',{ownerUpgradeResult:upgrade.response.body,sequenceIds:transitions.map(f=>f.id)});
const claimRecovery=gateway.fixtures.filter(f=>(f.request?.path?.endsWith('/work/claim') && /lost.*response|response.*lost/i.test(f.description??'')) || f.steps?.some(step=>/claim.*response.*lost|lost.*claim.*response/i.test(step.does)));
if(!claimRecovery.length)finding(217,'lost claim response','a fixture specifying retry of {runId} after claim succeeded but response was lost, without leasing another item or double-counting budget','no claim-response-loss fixture; act idempotency alone does not define claim recovery');
const multi={...gateway.f('reply-sent').request.body,text:'😀'.repeat(1100)};
if(gateway.def('actRequest')(multi)&&Buffer.byteLength(multi.text)>4096&&Buffer.byteLength(JSON.stringify(multi))<=8192)finding(217,'UTF-8 reply limit','explicit 4096-byte reply guard and multibyte boundary fixture in addition to JSON Schema maxLength',{schemaAccepts:true,textBytes:Buffer.byteLength(multi.text),requestBytes:Buffer.byteLength(JSON.stringify(multi)),schemaMaxLength:gateway.schema.definitions.actRequest.properties.text.maxLength});
assert.equal(networkCalls,0);
const result={base:BASE,publications:loaded.map(c=>({pr:c.pr,id:c.id,sha:c.sha,count:c.fixtures.length,fixtureTree:git('rev-parse',`${c.sha}:${c.root.slice(0,-1)}`),schemaSha256:createHash('sha256').update(bytes(c.sha,c.root+'schemas.json')).digest('hex')})),checks,findings,networkCalls};
console.log(JSON.stringify(result,null,2));
if(process.env.ENVOI_CONTRACT_REVIEW_RESULT)writeFileSync(process.env.ENVOI_CONTRACT_REVIEW_RESULT,JSON.stringify(result,null,2)+'\n');
process.exitCode=checks.some(c=>!c.ok) ? 1 : findings.length ? 2 : 0;

