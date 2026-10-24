import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {FileStore} from '../src/storage.js';
import {createHttpWake} from '../src/http-wake.js';
import {createProviderEventWake,signProviderWebhook} from '../src/provider-event-wake.js';
import {createMcpWakeTools} from '../src/mcp-wake-tools.js';
import {createWakeTransport} from '../src/http-wake-transport.js';
import {EventEmitter} from 'node:events';
import {wakeSubscriptionPath,wakeQueueDir} from '../src/http-wake-paths.js';

const pair=crypto.generateKeyPairSync('ed25519');
const keys=JSON.stringify([{kid:'provider_test',privateKey:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),activeFrom:'2026-01-01T00:00:00Z'}]);
const identity={inboxId:'inbox_provider',agent:{id:'agent_provider',permissions:['receive_agent_messages']},family:{id:'family_provider',audience:'https://envoi.example/mcp',oauthClientId:'client_test'},installationId:'installation_provider',familyId:'family_provider'};
const binding={inboxId:identity.inboxId,agentId:identity.agent.id,familyId:identity.familyId,installationId:identity.installationId};
const secret=`whsec_${Buffer.alloc(32,5).toString('base64')}`;
const secondSecret=`whsec_${Buffer.alloc(32,6).toString('base64')}`;
const protocol='2026-07-28';
const parameters=(overrides={})=>({name:'envoi.work_available',arguments:{},delivery:{mode:'webhook',url:'https://callbacks.envoi-provider.com/events',secret},...overrides});
async function harness(t,kind='file',overrides={}){
  let store;
  if(kind==='postgres'){
    const {PostgresStore}=await import('../src/postgres-storage.js');const base=new PostgresStore(process.env.DATABASE_URL);await base.init();const prefix=`test/provider_wake_${crypto.randomUUID()}`;
    store={withTransaction:base.withTransaction.bind(base),getJson:(p,d)=>base.getJson(`${prefix}/${p}`,d),putJson:(p,v)=>base.putJson(`${prefix}/${p}`,v),listJson:p=>base.listJson(`${prefix}/${p}`),deleteJson:p=>base.deleteJson(`${prefix}/${p}`)};t.after(async()=>{try{await base.deleteJsonTree(prefix);}finally{await base.close();}});
  }else{const dir=await mkdtemp(path.join(process.cwd(),'.provider-wake-test-'));store=new FileStore(dir);await store.init();t.after(()=>rm(dir,{recursive:true,force:true}));}
  let clock=Date.parse('2026-10-24T12:00:00Z'),response={status:202,failureClass:null},beforeResolve,verificationResponse;
  const sent=[],audits=[],state={family:{refreshExpiresAt:'2027-01-01T00:00:00Z'},agent:{status:'active',onboardingStatus:'approved'},installation:{status:'active'}};
  const now=()=>new Date(clock).toISOString();
  const resolveDestination=async url=>{await beforeResolve?.();return {url,addresses:['192.0.43.11']};};
  const options={store,enabled:true,installationsEnabled:true,mcpWakeEnabled:true,mcpEventsEnabled:true,grokTriggerEnabled:true,env:{ENVOI_WAKE_SIGNING_KEYS:keys},facts:async()=>state,now,random:()=>0.5,resolveDestination,observe:()=>{},audit:async(...args)=>audits.push(args),transport:async request=>{sent.push(request);const body=JSON.parse(request.bodyText);return body.type==='verification'?(verificationResponse||{status:200,failureClass:null,bodyText:JSON.stringify({challenge:body.challenge})}):response;},...overrides};
  const http=createHttpWake(options);
  const providerOptions={httpWake:http,store,mcpEventsEnabled:options.mcpEventsEnabled,grokTriggerEnabled:options.grokTriggerEnabled,key:Buffer.alloc(32,7),env:{ENVOI_MCP_EVENTS_CALLBACK_ORIGINS:'https://callbacks.envoi-provider.com',ENVOI_GROK_TRIGGER_ORIGINS:'https://triggers.envoi-provider.com'},now,resolveDestination,audit:options.audit,eventHistory:async()=>({cursor:'00000000000000000012',truncated:false,events:[]})};
  const provider=createProviderEventWake(providerOptions);await http.startup();
  const tx=fn=>store.withTransaction([`inbox:${identity.inboxId}:mutations`],fn);
  return {store,http,provider,options,providerOptions,now,tx,state,sent,audits,advance:ms=>clock+=ms,response:r=>response=r,beforeResolve:fn=>beforeResolve=fn,verificationResponse:r=>verificationResponse=r};
}
function parity(name,operation){for(const kind of ['file','postgres'])test(`${kind}: ${name}`,{skip:kind==='postgres'&&!process.env.DATABASE_URL},t=>operation(t,kind));}
const verifyHmac=(request,key=secret,index=0)=>{
  const content=`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.bodyText}`;
  const expected=crypto.createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(content).digest('base64');
  assert.equal(request.headers['webhook-signature'].split(' ')[index],`v1,${expected}`);
};

parity('MCP events verify, renew deterministically, rotate secrets and reuse the durable wake queue',async(t,kind)=>{
  const h=await harness(t,kind);
  const first=await h.provider.subscribe(identity,parameters(),protocol);assert.match(first.id,/^evtsub_[0-9a-f]{20}$/);assert.equal(first.cursor,'00000000000000000012');
  verifyHmac(h.sent[0]);assert.equal(JSON.parse(h.sent[0].bodyText).type,'verification');
  const stored=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));assert.equal(JSON.stringify(stored).includes(secret),false);assert.ok(stored.secretEncrypted.ciphertext);
  h.advance(1000);const renewed=await h.provider.subscribe(identity,parameters(),protocol);assert.equal(renewed.id,first.id);assert.notEqual(renewed.refreshBefore,first.refreshBefore);assert.equal(h.sent.length,1);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));await h.http.runOnce();const event=h.sent.at(-1);verifyHmac(event);const body=JSON.parse(event.bodyText);assert.equal(body.name,'envoi.work_available');assert.equal(body.eventId,event.headers['webhook-id']);assert.deepEqual(body.data,{reason:'message_delivered'});assert.equal(body.cursor,first.cursor);assert.equal(Buffer.byteLength(event.bodyText)<1024,true);assert.equal('agentId' in body,false);
  const params=parameters({delivery:{...parameters().delivery,secret:secondSecret}});await h.provider.subscribe(identity,params,protocol);assert.equal(JSON.parse(h.sent.at(-1).bodyText).type,'verification');
  await h.tx(()=>h.http.trigger({...binding,reason:'work_due'}));await h.http.runOnce();verifyHmac(h.sent.at(-1),secondSecret);verifyHmac(h.sent.at(-1),secret,1);
  h.advance(600001);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));await h.http.runOnce();assert.equal(h.sent.at(-1).headers['webhook-signature'].split(' ').length,1);assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id))).previousSecretEncrypted,undefined);
  assert.ok((await h.store.listJson(wakeQueueDir)).length>=3);
});
parity('provider retry preserves event identity and raw bytes with a fresh signing clock',async(t,kind)=>{
  const h=await harness(t,kind);await h.provider.subscribe(identity,parameters(),protocol);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));h.response({status:429,failureClass:'http_retryable',retryAfterSeconds:60});await h.http.runOnce();const first=h.sent.at(-1);h.advance(59000);assert.equal(await h.http.runOnce(),false);h.advance(1000);h.response({status:202,failureClass:null});await h.http.runOnce();const second=h.sent.at(-1);assert.equal(second.bodyText,first.bodyText);assert.equal(second.headers['webhook-id'],first.headers['webhook-id']);assert.notEqual(second.headers['webhook-timestamp'],first.headers['webhook-timestamp']);verifyHmac(second);
});
parity('unsubscribe deletes secrets, invalidates verification and fences previous generations',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.subscribe(identity,parameters(),protocol);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));
  const {secret:_,...delivery}=parameters().delivery;const unsubscribe={name:parameters().name,arguments:{},delivery};assert.deepEqual(await h.tx(()=>h.provider.unsubscribe(identity,unsubscribe,protocol)),{});assert.deepEqual(await h.tx(()=>h.provider.unsubscribe(identity,unsubscribe,protocol)),{});
  const ended=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));assert.equal(ended.secretEncrypted,undefined);assert.equal(ended.status,'ended');const sent=h.sent.length;
  await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,sent+1);assert.equal(await h.http.runOnce(),false);
});
parity('Grok 202 is receipt only; 401 pauses and owner secret replacement resumes; sender defects do not retry',async(t,kind)=>{
  const h=await harness(t,kind);const put=()=>h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/run',secret});const initial=await h.tx(put);assert.equal(initial.target.secretSet,true);assert.equal(JSON.stringify(initial).includes(secret),false);
  h.response({status:401,failureClass:'http_rejected'});await h.http.runOnce();assert.equal((await h.provider.getGrok(binding)).target.state,'needs_secret');h.advance(120000);assert.equal(await h.http.runOnce(),false);
  await h.tx(put);h.response({status:202,failureClass:null});await h.http.runOnce();const accepted=(await h.provider.getGrok(binding)).target;assert.equal(accepted.state,'active');assert.ok(accepted.lastAcceptedAt);assert.equal('processedAt' in accepted,false);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));assert.equal(await h.http.runOnce(),false);h.advance(5000);h.response({status:413,failureClass:'http_rejected'});await h.http.runOnce();assert.equal((await h.provider.getGrok(binding)).target.state,'needs_attention');assert.ok(h.audits.some(row=>row[1]==='agent.wake_target_attention'));
  await h.tx(()=>h.provider.deleteGrok(binding));const record=await h.store.getJson(wakeSubscriptionPath(binding.agentId,initial.target.id));assert.equal(record.secretEncrypted,undefined);
});
parity('flag-off ends only its profile, durably deletes secrets and preserves Ed25519 REST subscriptions',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/rest'}));const provider=await h.provider.subscribe(identity,parameters(),protocol);h.advance(1);
  const off=createHttpWake({...h.options,mcpEventsEnabled:false});createProviderEventWake({...h.providerOptions,httpWake:off,mcpEventsEnabled:false});await off.startup();
  const records=await h.tx(()=>off.profileRecords(binding,'mcp_events'));assert.equal(records[0].endedReason,'feature_disabled');assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,provider.id))).secretEncrypted,undefined);assert.equal((await off.list(binding)).subscriptions.find(row=>row.id===created.subscription.id).status,'pending');
  const restored=createHttpWake(h.options);createProviderEventWake({...h.providerOptions,httpWake:restored});await restored.startup();assert.equal((await restored.profileRecords(binding,'mcp_events'))[0].status,'ended');
});
parity('pause emits control only; revoke or explicit installation end blocks effects and erases secrets',async(t,kind)=>{
  const h=await harness(t,kind);const control=parameters({name:'envoi.control_changed'});const created=await h.provider.subscribe(identity,control,protocol);h.state.agent.status='paused';await h.tx(()=>h.http.pause(binding.inboxId,binding.agentId));await h.http.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).name,'envoi.control_changed');
  h.state.agent.status='active';await h.tx(()=>h.http.trigger({...binding,type:'wake.control_changed',reason:'case_controlled'}));h.beforeResolve(()=>{h.state.installation.status='ended';});const count=h.sent.length;await h.http.runOnce();assert.equal(h.sent.length,count);const record=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id));assert.equal(record.endedReason,'credential_ended');assert.equal(record.secretEncrypted,undefined);
});
test('methods require qualifying audience and MCP2026; closed inputs and TTL/secret bounds are enforced',async t=>{
  const h=await harness(t);assert.deepEqual(h.provider.discover(identity,'2025-11-25'),{});assert.deepEqual(h.provider.discover(identity,protocol),{events:{}});assert.throws(()=>h.provider.list(identity,{},'2025-11-25'),{rpcCode:-32601});assert.throws(()=>h.provider.list({...identity,family:{}},{},protocol),{rpcCode:-32601});
  for(const params of [parameters({ttlMs:10}),parameters({ttlMs:604800001}),parameters({arguments:{agentId:'foreign'}}),parameters({delivery:{...parameters().delivery,secret:'whsec_short'}})])await assert.rejects(h.provider.subscribe(identity,params,protocol),{rpcCode:-32602});
  await assert.rejects(h.provider.unsubscribe(identity,{name:'envoi.work_available',arguments:{},delivery:{url:parameters().delivery.url}},protocol),{rpcCode:-32602});
});
test('empty operator allowlists are inert before DNS or verification; cache hits still check DNS',async t=>{
  const h=await harness(t);const emptyHttp=createHttpWake(h.options);const emptyProvider=createProviderEventWake({...h.providerOptions,httpWake:emptyHttp,env:{}});let calls=0;h.beforeResolve(()=>calls++);
  await assert.rejects(emptyProvider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'origin_not_allowed'});await assert.rejects(emptyProvider.putGrok(binding,{url:'https://triggers.envoi-provider.com/run',secret}),{code:'WAKE_URL_REJECTED',reason:'origin_not_allowed'});assert.equal(calls,0);
  await h.provider.subscribe(identity,parameters(),protocol);h.beforeResolve(()=>{throw new Error('Private address');});await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'address_not_allowed'});
});
test('verification failures persist no subscription or secret; cache expiry requires a new challenge',async t=>{
  const h=await harness(t);h.verificationResponse({status:200,failureClass:null,bodyText:'{"challenge":"wrong"}'});await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'challenge_failed'});assert.deepEqual(await h.http.profileRecords(binding,'mcp_events'),[]);
  h.verificationResponse(null);await h.provider.subscribe(identity,parameters(),protocol);const count=h.sent.length;h.advance(3599000);await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,count);h.advance(1001);await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,count+1);
});
test('MCP tool route/origin binding precedes DNS, hidden createdVia, installation isolation and durable flag-off',async t=>{
  const h=await harness(t);let client={connectionRoute:'provider_connector',wakeOrigins:['https://callbacks.envoi-provider.com']};const tools=createMcpWakeTools({enabled:true,httpWake:h.http,clientFor:()=>client});let dns=0;h.beforeResolve(()=>dns++);
  const refused=JSON.parse((await tools.call('envoi_wake_create',{url:'https://elsewhere.envoi-provider.com/wake'},identity)).content[0].text);assert.equal(refused.code,'WAKE_URL_REJECTED');assert.equal(refused.reason,'origin_not_declared');assert.equal(dns,0);
  client={connectionRoute:'remote_mcp_oauth'};assert.equal(JSON.parse((await tools.call('envoi_wake_create',{url:parameters().delivery.url},identity)).content[0].text).code,'WAKE_ROUTE_NOT_SUPPORTED');client={connectionRoute:'provider_connector',wakeOrigins:['https://callbacks.envoi-provider.com']};
  const created=JSON.parse((await h.tx(()=>tools.call('envoi_wake_create',{url:parameters().delivery.url},identity))).content[0].text);assert.equal(created.ok,true);assert.equal('createdVia' in created.result.subscription,false);const id=created.result.subscription.id;assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,id))).createdVia,'mcp');
  const foreign=JSON.parse((await tools.call('envoi_wake_end',{subscriptionId:id},{...identity,installationId:'another_installation'})).content[0].text);assert.equal(foreign.code,'WAKE_SUBSCRIPTION_NOT_FOUND');
  h.advance(1);const off=createHttpWake({...h.options,mcpWakeEnabled:false});await off.startup();assert.equal((await off.list(binding)).subscriptions[0].endedReason,'feature_disabled');assert.equal(createMcpWakeTools({enabled:false,httpWake:h.http}).available(identity),false);assert.equal(tools.available({...identity,mcpScope:{caseId:'case_private'}}),false);
});
test('Standard Webhooks signs supplied decoded bytes and never uses the Ed25519 headers',()=>{
  const headers=signProviderWebhook({secret,bodyText:'{}',id:'wake_evt_test',at:'2026-10-24T12:00:00Z'});verifyHmac({headers,bodyText:'{}'});assert.equal(headers['envoi-wake-signature'],undefined);
});
parity('MCP and provider creates share durable quotas before DNS; no installation can multiply events by retrying',async(t,kind)=>{
  const h=await harness(t,kind);let dns=0;h.beforeResolve(()=>dns++);h.verificationResponse({status:400,failureClass:'http_rejected'});
  for(let attempt=0;attempt<5;attempt++)await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015});
  const prior=dns;await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{code:'RATE_LIMITED'});assert.equal(dns,prior);
  await assert.rejects(h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/rest'})),{code:'RATE_LIMITED'});assert.equal(dns,prior);
});
test('provider transport reads only opt-in bounded verification bodies and honors Retry-After on all retry statuses',async()=>{
  for(const [status,readResponseBody]of [[425,true],[500,false]]){
    const send=createWakeTransport({request:(_url,_options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'retry-after':'90'};res.destroy=()=>res.emit('close');callback(res);res.emit('data',Buffer.from('{"challenge":"ok"}'));res.emit('end');};return req;}});
    const result=await send({url:'https://callbacks.envoi-provider.com/events',addresses:['192.0.43.11'],headers:{},bodyText:'{}',standardWebhooks:true,readResponseBody});assert.equal(result.retryAfterSeconds,90);assert.equal(result.bodyText,readResponseBody?'{"challenge":"ok"}':undefined);
  }
});
