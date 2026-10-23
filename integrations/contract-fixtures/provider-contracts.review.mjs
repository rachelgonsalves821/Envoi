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
  { pr: 216, id: 'provider-event-wake', sha: process.env.ENVOI_EVENT_CONTRACT_SHA ?? 'd920f65cf2ad2ec1933ab92c29d46fbdb4397a7b', count: 49 },
  { pr: 217, id: 'provider-gateway-native', sha: process.env.ENVOI_GATEWAY_CONTRACT_SHA ?? 'b785836f2fb2e2874e4a317c12fd5a0346feada5', count: 44 },
  { pr: 218, id: 'provider-connector-tools', sha: '3af8669a907c316b95ff92fa7031a50a654e1a18', count: 6 }
];
assert.ok(publications.every(p => /^[a-f0-9]{40}$/.test(p.sha)), 'exact Git publication SHAs required');
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

// Revision-2 checks independently consume the new boundary fixtures; no production calls.
check('provider-event-wake E1: closed unsubscribe shape, idempotent response and missing-mode refusal', () => {
  const validate = events.def('unsubscribeParams');
  for (const id of ['unsubscribe-ok', 'unsubscribe-unknown-is-idempotent']) {
    const f = events.f(id), params = f.request.body.params;
    assert.equal(validate(params), true, id);
    assert.equal(params.delivery.mode, 'webhook');
    assert.deepEqual(f.response.body.result, {});
    assert.equal(validate({...params, ownerId:'other'}), false);
    const {mode, ...missing} = params.delivery;
    assert.equal(validate({...params, delivery:missing}), false);
    assert.equal(validate({...params, delivery:{...params.delivery, secret:'not-an-unsubscribe-field'}}), false);
  }
  assert.equal(validate(events.f('unsubscribe-delivery-mode-missing').request.body.params), false);
  assert.equal(events.f('unsubscribe-delivery-mode-missing').response.body.error.code, -32602);
});
check('provider-event-wake E2: cache isolation, expiry, rotation and fresh destination validation', () => {
  const policy = events.schema['x-verification-cache'];
  assert.equal(policy.ttlSeconds, 3600);
  const hit = events.f('subscribe-renewed-same-identity'), cache = hit.context.verificationCache;
  // Fixture-only cache decision: no network/cache/secret storage is implemented.
  const reusable = (principal, url, epoch, age, destinationAllowed, invalidated=false) =>
    !invalidated && destinationAllowed && principal === cache.principal && url === cache.url
      && epoch === cache.secretVersion && Number.isFinite(age) && age >= 0 && age < policy.ttlSeconds;
  assert.equal(reusable(cache.principal, cache.url, cache.secretVersion, cache.ageSeconds, true), true);
  for (const args of [
    ['other-installation',cache.url,cache.secretVersion,cache.ageSeconds,true],
    [cache.principal,cache.url+'/other',cache.secretVersion,cache.ageSeconds,true],
    [cache.principal,cache.url,cache.secretVersion+1,cache.ageSeconds,true],
    [cache.principal,cache.url,cache.secretVersion,3601,true],
    [cache.principal,cache.url,cache.secretVersion,cache.ageSeconds,false],
    [cache.principal,cache.url,cache.secretVersion,cache.ageSeconds,true,true],
  ]) assert.equal(reusable(...args),false);
  for (const [id,state,sent] of [
    ['subscribe-created','miss',true],['subscribe-renewed-same-identity','hit',false],
    ['subscribe-renewed-secret-rotated','invalidated_secret',true],
    ['subscribe-verification-cache-expired','expired',true],
    ['subscribe-verification-binding-changed','invalidated_url',true],
    ['subscribe-cache-hit-address-now-disallowed','dropped',false]
  ]) {
    const f=events.f(id); assert.equal(f.effects.verificationCache,state,id);
    assert.equal(f.effects.verificationSent,sent,id);
    if(f.context?.verificationCache) assert.equal(f.effects.destinationChecksRerun,true,id);
  }
  assert.equal(events.f('subscribe-cache-hit-address-now-disallowed').response.body.error.data.reason,'address_not_allowed');
  for(const reason of ['expiry','secret_changed','url_changed','allowlist_changed','subscription_ended','installation_ended','flag_off']) assert.ok(policy.invalidatedBy.includes(reason));
  assert.equal(events.f('subscribe-renewed-secret-rotated').effects.dualSignSeconds,600);
});
check('provider-event-wake E3: causal clocks and freshness independent of valid raw-byte HMAC', () => {
  const tolerance=events.schema['x-clock'].toleranceSeconds;assert.equal(tolerance,300);
  for(const f of events.fixtures.filter(f=>f.kind==='delivery')){
    const d=f.delivery, ts=Number(d.request.headers['webhook-timestamp']), body=JSON.parse(d.request.bodyText);
    assert.equal(ts, Math.floor(Date.parse(d.sentAt)/1000), f.id);
    const eventAt=Date.parse(body.timestamp??body.createdAt??'');
    if(Number.isFinite(eventAt)) assert.ok(ts*1000>=eventAt, f.id+': event precedes signing');
    if(['acknowledged','accepted_receipt_only','verified'].includes(d.outcome)) assert.ok(d.receiver,f.id+': successful delivery declares receiver clock');
    if(d.receiver){
      const delta=Math.floor(Date.parse(d.receiver.asOf)/1000)-ts;
      assert.equal(d.receiver.deltaSeconds,delta,f.id);
      assert.equal(d.receiver.verdict,Math.abs(delta)<=tolerance?'accept':'reject',f.id);
    }
  }
  const live=events.f('delivery-work-available').delivery, stale=events.f('delivery-replayed-stale').delivery;
  assert.deepEqual(live.request,stale.request,'valid HMAC/raw bytes are unchanged by receiver time');
  assert.equal(live.receiver.verdict,'accept');assert.equal(stale.receiver.verdict,'reject');
  for(const id of ['delivery-future-timestamp-rejected','delivery-clock-edge-301s-rejected','grok-delivery-replayed-stale'])assert.equal(events.f(id).delivery.receiver.verdict,'reject');
  assert.equal(events.f('delivery-clock-edge-300s-accepted').delivery.receiver.verdict,'accept');
  for(const [a,b] of [['delivery-503-retries','delivery-retry-new-signature'],['grok-delivery-429-retry-after','grok-delivery-retry-fresh-clock']]){
    const first=events.f(a).delivery, next=events.f(b).delivery;
    assert.equal(next.request.headers['webhook-id'],first.request.headers['webhook-id']);
    assert.notEqual(next.request.headers['webhook-signature'],first.request.headers['webhook-signature']);
    assert.ok(Date.parse(next.sentAt)-Date.parse(first.sentAt)>=Number(first.response.headers['retry-after'])*1000);
  }
});
check('provider-gateway-native G1: owner-only repair, ended old generation and bounded new session', () => {
  const upgrade=gateway.f('scope-upgrade-owner'), old=gateway.f('old-session-refused-after-upgrade');
  const activation=gateway.f('repair-activate-native-scope'), claim=gateway.f('claim-new-generation-ok');
  assert.equal(upgrade.request.auth,'human_session');
  assert.equal(upgrade.response.headers['set-cookie'],undefined);
  assert.equal(upgrade.response.body.generation,upgrade.response.body.previousGeneration+1);
  assert.equal(old.response.status,401);assert.equal(old.response.body.reason,'generation_changed');
  assert.equal(gateway.f('repair-pairing-created').request.path,'/api/agent-gateway/pairings');
  assert.equal(activation.request.path,'/api/agent-gateway/pairing/activate');
  const cookies=activation.response.headers['set-cookie'];assert.equal(cookies.length,2);
  assert.ok(cookies[0].includes('Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'));
  assert.ok(cookies[1].includes('Max-Age=0'));
  assert.equal(Date.parse(activation.response.body.expiresAt)-Date.parse(activation.context.ownerConfirmedAt),7*24*3600*1000);
  assert.equal(claim.context.session.generation,upgrade.response.body.generation);
  assert.equal(claim.request.headers.cookie,cookies[0].split(';')[0]);
  assert.equal(claim.context.session.absoluteExpiresAt,activation.response.body.expiresAt);
  assert.equal(claim.response.body.packet.runId,claim.request.body.runId);
});
check('provider-gateway-native G2: outstanding replay preserves packet, lease and item budget across restart', () => {
  const first=gateway.f('claim-work');
  for(const id of ['claim-lost-response-replay','claim-lost-response-after-restart']){
    const f=gateway.f(id);assert.deepEqual(f.request.body,first.request.body);
    assert.deepEqual({...f.response.body,replayed:false},first.response.body,id);
    assert.equal(f.effects.newLease,false);assert.equal(f.effects.itemsClaimedThisRunAfter,f.context.itemsClaimedThisRun);
  }
  assert.equal(gateway.f('claim-lost-response-after-restart').context.serverRestarted,true);
  const next=gateway.f('claim-next-item-after-settlement');
  assert.equal(next.context.outstandingClaim.settled,true);assert.equal(next.effects.newLease,true);
  assert.notEqual(next.response.body.packet.workRef,first.response.body.packet.workRef);
  assert.equal(next.effects.itemsClaimedThisRunAfter,next.context.itemsClaimedThisRun+1);
  const other=gateway.f('claim-other-run-while-active');
  assert.notEqual(other.request.body.runId,other.context.outstandingClaim.runId);
  assert.equal(other.response.body.code,'GATEWAY_CHECK_ACTIVE');assert.equal(other.response.status,409);
  assert.ok(Number(other.response.headers['retry-after'])>0);
  assert.deepEqual(gateway.schema['x-claim-replay'].key,['installation','runId']);
  assert.equal(gateway.schema['x-claim-replay'].survivesRestart,true);
});
check('provider-gateway-native G3: actual UTF-8 request/reply/summary boundaries and no replacement character', () => {
  const limits=gateway.schema['x-limits'];
  const valid=body=>gateway.def('actRequest')(body) && Buffer.byteLength(JSON.stringify(body))<=limits.requestMaxBytes
    && (body.text===undefined||Buffer.byteLength(body.text)<=limits.replyTextMaxBytes);
  for(const id of ['reply-text-ascii-at-byte-limit','reply-text-multibyte-at-byte-limit']){
    const f=gateway.f(id);assert.equal(Buffer.byteLength(f.request.body.text),4096);
    assert.equal(valid(f.request.body),true);assert.equal(f.response.body.state,'sent');
  }
  for(const id of ['reply-text-multibyte-over-byte-limit','reply-text-one-byte-over-limit']){
    const f=gateway.f(id);assert.equal(gateway.def('actRequest')(f.request.body),id==='reply-text-multibyte-over-byte-limit');
    assert.equal(valid(f.request.body),false);assert.equal(f.response.body.reason,'text_too_long');
  }
  const multi=gateway.f('reply-text-multibyte-over-byte-limit').request.body;
  assert.equal(Array.from(multi.text).length,1100);assert.equal(Buffer.byteLength(multi.text),4400);
  assert.ok(Buffer.byteLength(JSON.stringify(multi))<8192);
  for(const f of gateway.fixtures){
    if(f.response)assert.ok(Buffer.byteLength(JSON.stringify(f.response.body))<=limits.responseMaxBytes);
    for(const e of f.response?.body?.packet?.snapshot?.recentEvents??[]){
      assert.ok(Buffer.byteLength(e.summary)<=limits.summaryMaxBytes);assert.ok(!e.summary.includes('\uFFFD'));
    }
  }
  const truncated=gateway.f('claim-summary-truncated-on-code-point').response.body.packet.snapshot.recentEvents[0];
  assert.equal(Buffer.byteLength(truncated.summary),2048);assert.equal(truncated.truncated,true);
});

// Causal/state probes stay separate from schema-positive tests so contradictions are explicit findings.
const eventText=bytes(events.sha,'docs/architecture/agent-native-v2/handoffs.md').toString().split('## provider-event-wake v1')[1].split('\n## ')[0];
const decisions=eventText.match(/### [^\n]*Decisions for review[\s\S]*?(?=\n### |$)/i)?.[0]??'';
if(decisions.split('\n').filter(line=>/allowlists empty by default/.test(line)).length>1)
 finding(216,'decision text: duplicate allowlist / spliced custody choice','distinct complete allowlist, verification-cache and encrypted-secret-custody decisions',decisions);
const activation=gateway.f('repair-activate-native-scope'), fresh=gateway.f('claim-new-generation-ok');
const confirmedAt=Date.parse(activation.context.ownerConfirmedAt), freshLease=Date.parse(fresh.response.body.packet.leaseExpiresAt);
if(freshLease<=confirmedAt)finding(217,'G1: repaired-session claim already expired before owner confirmation','the successful generation-5 claim follows repair activation and has a live lease',{ownerConfirmedAt:activation.context.ownerConfirmedAt,newSessionExpiresAt:activation.response.body.expiresAt,successfulClaimLeaseExpiresAt:fresh.response.body.packet.leaseExpiresAt});
const expired=gateway.f('claim-replay-after-lease-expiry'), limits=gateway.schema['x-limits'];
if(expired.context.outstandingClaim.leaseExpired && expired.request.body.runId===expired.context.outstandingClaim.runId
  && expired.response.status===200 && expired.effects.newLease && limits.leaseSeconds>limits.runBudgetSeconds)
 finding(217,'G2: expired-lease retry creates new work in a run whose time budget must be exhausted','an old run cannot obtain a fresh lease after its 150-second lease expires when the entire run budget is120seconds; publish old-run refusal and new-run recovery', {leaseSeconds:limits.leaseSeconds,runBudgetSeconds:limits.runBudgetSeconds,requestRunId:expired.request.body.runId,priorRunId:expired.context.outstandingClaim.runId,newLease:expired.effects.newLease});
assert.equal(networkCalls,0);
const result={base:BASE,publications:loaded.map(c=>({pr:c.pr,id:c.id,sha:c.sha,count:c.fixtures.length,fixtureTree:git('rev-parse',`${c.sha}:${c.root.slice(0,-1)}`),schemaSha256:createHash('sha256').update(bytes(c.sha,c.root+'schemas.json')).digest('hex')})),checks,findings,networkCalls};
console.log(JSON.stringify(result,null,2));
if(process.env.ENVOI_CONTRACT_REVIEW_RESULT)writeFileSync(process.env.ENVOI_CONTRACT_REVIEW_RESULT,JSON.stringify(result,null,2)+'\n');
process.exitCode=checks.some(c=>!c.ok) ? 1 : findings.length ? 2 : 0;

