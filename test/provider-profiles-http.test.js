// Real HTTP composition of profiles, using only synthetic local owners and stored verification facts.
// The deliberately reserved callback is never contacted; transport verification/delivery is tested with injected mocks separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, backends, remoteServer, documents, freshOwner, connect, exchange, assertTokenResponse, stored, providerClient } from './agent-remote-auth-token-harness.js';
const key=crypto.generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
const client={...providerClient,wakeOrigins:['https://callbacks.envoi-provider.com']};
for(const backend of backends)test(`[${backend.name}] real MCP profiles use derived installation authority and owner-only Grok controls`,{timeout:90000},async t=>{
  const server=await remoteServer(t,backend,{providers:true,clients:[client],env:{ENVOI_HTTP_WAKE_V1:'true',ENVOI_MCP_WAKE_V1:'true',ENVOI_MCP_EVENTS_V1:'true',ENVOI_GROK_TRIGGER_V1:'true',ENVOI_WAKE_SIGNING_KEYS:JSON.stringify([{kid:'profile-http',privateKey:key,activeFrom:'2026-01-01T00:00:00Z'}])}});
  const docs=documents(t,server),who=await freshOwner(server),grant=await connect(server,who,{client}),tokens=assertTokenResponse(await exchange(server,grant));
  const {registration}=await stored(docs,grant.registrationId);
  const rpc=(method,params={},version='2025-11-25')=>api(server.baseUrl,'/mcp',{token:tokens.access_token,body:{jsonrpc:'2.0',id:1,method,params},headers:{accept:'application/json, text/event-stream','mcp-protocol-version':version}});
  const tool=async(name,args={})=>{const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.status,200,response.text);return JSON.parse(response.payload.result.content[0].text);};
  const listed=await rpc('tools/list');assert.equal(listed.status,200,listed.text);
  assert.equal(listed.payload.result.tools.filter(value=>value.name.startsWith('envoi_wake_')).length,4);
  const installation=await docs.get(['auth','agent-installations',registration.agentInboxId,registration.agentId,`${registration.installationId}.json`]);
  assert.equal(installation.status,undefined,'canonical installation documents store immutable fields; active status is derived from the family');
  const id='wake_sub_http_fixture',challenge='envoi_wake_challenge_'+'a'.repeat(43),at=new Date().toISOString();
  await docs.put(['http-wake','agents',registration.agentId,'wake-subscriptions',`${id}.json`],{id,inboxId:registration.agentInboxId,agentId:registration.agentId,familyId:registration.credentialFamilyId,installationId:registration.installationId,createdVia:'mcp',url:'https://localhost/fixture-never-sent',status:'pending',endedReason:null,endedAt:null,createdAt:at,activatedAt:null,expiresAt:null,challengeExpiresAt:new Date(Date.now()+600000).toISOString(),replacesSubscriptionId:null,challengeHash:crypto.createHash('sha256').update(challenge).digest('hex'),delivery:{state:'unverified',lastAttemptAt:null,lastSuccessAt:null,consecutiveFailures:0,lastFailureClass:null},liveEvents:{},dirty:{},sequence:0});
  const status=await tool('envoi_wake_status');assert.equal(status.ok,true);assert.equal(status.result.httpWake.subscription.status,'pending');
  const active=await tool('envoi_wake_activate',{subscriptionId:id,challenge});assert.equal(active.ok,true,JSON.stringify(active));assert.equal(active.result.subscription.status,'active');
  const ended=await tool('envoi_wake_end',{subscriptionId:id});assert.equal(ended.ok,true);assert.equal(ended.result.subscription.status,'ended');
  const discovered=await rpc('server/discover',{},'2026-07-28');assert.equal(discovered.status,200,discovered.text);assert.deepEqual(discovered.payload.result.capabilities,{tools:{},events:{}});
  const cursor=await rpc('events/subscribe',{name:'envoi.work_available',arguments:{},delivery:{mode:'webhook',url:'https://localhost/no-contact',secret:'whsec_'+Buffer.alloc(32,4).toString('base64')},cursor:'99999999999999999999'},'2026-07-28');
  assert.equal(cursor.status,200,cursor.text);assert.equal(cursor.payload.error.code,-32602,'future cursor is rejected before callback origin/DNS checks');
  const route=`/api/inboxes/${registration.agentInboxId}/agents/${registration.agentId}/wake-targets/grok`;
  const own=await api(server.baseUrl,route,{session:who.session});assert.equal(own.status,200,own.text);assert.equal(own.payload.target,null);
  assert.equal((await api(server.baseUrl,route,{token:tokens.access_token})).status,401,'OAuth access is never owner authority');
  const foreign=await freshOwner(server);assert.equal((await api(server.baseUrl,route,{session:foreign.session})).status,403);
  const invalid=await api(server.baseUrl,route,{session:who.session,method:'PUT',body:{url:'https://localhost/no-contact',secret:'invalid'}});assert.equal(invalid.payload.code,'WAKE_TARGET_INVALID');
  const removed=await api(server.baseUrl,route,{session:who.session,method:'DELETE',body:{}});assert.equal(removed.status,200,removed.text);assert.deepEqual(removed.payload,{});
});
