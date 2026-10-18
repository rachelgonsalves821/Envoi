import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { createHttpWake } from '../src/http-wake.js';
import { createWakeDestination } from '../src/http-wake-destination.js';
import { createWakeKeys,createWakeTransport,classifyWakeStatus } from '../src/http-wake-transport.js';
import { createWakeAdmission,wakeNetwork } from '../src/http-wake-limits.js';
import { EventEmitter } from 'node:events';

const fixtureDir=new URL('./contract-fixtures/http-wake/',import.meta.url);
const schema=JSON.parse(await readFile(new URL('schemas.json',fixtureDir)));
const keyPair=crypto.generateKeyPairSync('ed25519');
const encoded=JSON.stringify([{kid:'wk_test',privateKey:keyPair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),activeFrom:'2026-01-01T00:00:00Z',notAfter:null}]);
const identity={inboxId:'inbox_test',agentId:'agent_test',installationId:'installation_test',familyId:'credential_family_test'};
async function harness(t,kind='file'){
  let store;
  if(kind==='postgres'){
    const {PostgresStore}=await import('../src/postgres-storage.js');
    const base=new PostgresStore(process.env.DATABASE_URL);await base.init();
    const prefix=`test/wake_${crypto.randomUUID()}`;
    store={withTransaction:base.withTransaction.bind(base),getJson:(p,d)=>base.getJson(`${prefix}/${p}`,d),putJson:(p,v)=>base.putJson(`${prefix}/${p}`,v),listJson:p=>base.listJson(`${prefix}/${p}`),deleteJson:p=>base.deleteJson(`${prefix}/${p}`)};
    t.after(async()=>{try{await base.deleteJsonTree(prefix);}finally{await base.close();}});
  }else{const dir=await mkdtemp(path.join(process.cwd(),'.wake-test-'));store=new FileStore(dir);await store.init();t.after(()=>rm(dir,{recursive:true,force:true}));}
  let clock=Date.parse('2026-10-18T12:00:00Z');
  const state={family:{refreshExpiresAt:'2027-01-01T00:00:00Z'},agent:{status:'active',onboardingStatus:'approved'}};
  const sent=[],audits=[];let response={status:204,failureClass:null};let beforeSend,beforeResolve;
  const options={store,enabled:true,installationsEnabled:true,env:{ENVOI_WAKE_SIGNING_KEYS:encoded},facts:async()=>state,now:()=>new Date(clock).toISOString(),random:()=>0.5,resolveDestination:async url=>{await beforeResolve?.();return {url,addresses:['192.0.32.10']};},transport:async request=>{await beforeSend?.();sent.push(request);return response;},audit:async(...args)=>audits.push(args)};
  const service=createHttpWake(options);await service.startup();
  const tx=fn=>store.withTransaction([`inbox:${identity.inboxId}:mutations`],fn);
  async function active(){const created=await tx(()=>service.create(identity,{url:'https://hooks.example.com/wake'}));clock+=2000;await service.runOnce();const challenge=JSON.parse(sent.at(-1).bodyText).challenge;await tx(()=>service.activate(identity,created.subscription.id,{challenge}));return {id:created.subscription.id,challenge};}
  return {store,service,options,state,sent,audits,tx,active,advance:ms=>clock+=ms,response:r=>response=r,beforeSend:fn=>beforeSend=fn,beforeResolve:fn=>beforeResolve=fn};
}
function storeTest(name,operation){
  for(const kind of ['file','postgres'])test(`${kind}: ${name}`,{skip:kind==='postgres'&&!process.env.DATABASE_URL},t=>operation(t,kind));
}

for(const kind of ['file','postgres'])test(`${kind}: challenge/activation, replay, coalescing, pause and revocation`,{skip:kind==='postgres'&&!process.env.DATABASE_URL},async t=>{
  const h=await harness(t,kind);const {id,challenge}=await h.active();
  const Ajv=(await import('ajv')).default;const addFormats=(await import('ajv-formats')).default;const ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema(schema);
  const validate=ajv.getSchema(`${schema.$id}#/definitions/subscriptionResponse`);
  const replay=await h.tx(()=>h.service.activate(identity,id,{challenge}));assert.ok(validate(replay),JSON.stringify(validate.errors));
  await assert.rejects(h.tx(()=>h.service.activate(identity,id,{challenge:'wrong'})),{code:'WAKE_CHALLENGE_INVALID'});
  await assert.rejects(h.tx(()=>h.service.end({...identity,installationId:'installation_other'},id)),{code:'WAKE_SUBSCRIPTION_NOT_FOUND'});
  await h.tx(()=>h.service.trigger({...identity,reason:'message_delivered'}));
  await h.service.runOnce();await h.service.runOnce();assert.equal(h.sent.filter(r=>JSON.parse(r.bodyText).type==='wake.work_available').length,2);
  assert.equal((await h.tx(()=>h.service.status(identity))).subscription.status,'active');
  await h.tx(()=>h.service.trigger({...identity,reason:'message_delivered'}));h.state.agent.status='paused';await h.tx(()=>h.service.pause(identity.inboxId,identity.agentId));await h.service.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).type,'wake.control_changed');
  h.state.agent.status='active';h.state.family.revokedAt='2026-10-18T12:00:02.000Z';
  const status=await h.tx(()=>h.service.status(identity));assert.equal(status.subscription.endedReason,'credential_ended');
  assert.equal((await h.tx(()=>h.service.end(identity,id))).subscription.endedReason,'credential_ended');
  assert.equal(h.audits.filter(a=>a[1]==='agent.wake_subscription_ended').length,1);
});

storeTest('durable retry preserves raw body and id, replacement cancels old queue, epoch prevents resurrection',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.active();h.response({status:503,failureClass:'http_retryable',retryAfterSeconds:60});await h.service.runOnce();const attempt=h.sent.at(-1);h.advance(59000);assert.equal(await h.service.runOnce(),false);h.advance(1000);
  const restarted=createHttpWake(h.options);await restarted.startup();h.response({status:204,failureClass:null});await restarted.runOnce();assert.equal(h.sent.at(-1).bodyText,attempt.bodyText);assert.equal(h.sent.at(-1).headers['envoi-wake-id'],attempt.headers['envoi-wake-id']);assert.notEqual(h.sent.at(-1).headers['envoi-wake-timestamp'],attempt.headers['envoi-wake-timestamp']);
  const second=await h.active();assert.notEqual(second.id,first.id);assert.equal((await h.tx(()=>h.service.list(identity))).subscriptions.find(s=>s.id===first.id).endedReason,'replaced');
  h.advance(1);await createHttpWake({...h.options,enabled:false}).startup();assert.equal((await h.tx(()=>h.service.status(identity))).subscription.endedReason,'feature_disabled');
});

storeTest('expiry, suppressed credentials and final challenge failures do not falsely report health',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.tx(()=>h.service.create(identity,{url:'https://hooks.example.com/wake'}));h.response({failureClass:'connect_failed'});h.advance(2000);await h.service.runOnce();h.advance(60000);assert.equal(await h.service.runOnce(),false);assert.equal((await h.tx(()=>h.service.list(identity))).subscriptions[0].delivery.state,'unverified');h.advance(600000);assert.equal((await h.tx(()=>h.service.list(identity))).subscriptions[0].endedReason,'challenge_expired');
  const {id}=await h.active();h.state.family.refreshExpiresAt='2026-01-01T00:00:00Z';const count=h.sent.length;await h.service.runOnce();assert.equal(h.sent.length,count);assert.equal((await h.tx(()=>h.service.status(identity))).subscription.status,'active');assert.notEqual(created.subscription.id,id);
});

test('destination checks consume canonical rejection fixtures; mixed DNS fails closed',async()=>{
  const destination=createWakeDestination({env:{ENVOI_PUBLIC_URL:'https://envoi.example',ENVOI_WAKE_SELF_HOSTS:'envoi-agents.com'}});
  for(const filename of ['url-rejected-port.json','url-rejected-trailing-dot.json','url-rejected-ip-literal.json','url-rejected-single-label.json','url-rejected-query.json','url-rejected-self-subdomain.json']){
    const fixture=JSON.parse(await readFile(new URL(filename,fixtureDir)));assert.throws(()=>destination.canonical(fixture.request.body.url),{reason:fixture.response.body.reason});
  }
  assert.equal(destination.allowed('::ffff:192.0.32.10'),false);assert.equal(destination.allowed('64:ff9b::c000:200a'),false);assert.equal(destination.allowed('3fff::1'),false);assert.equal(destination.allowed('192.0.32.10'),true);
  const bad=createWakeDestination({env:{},resolver:{resolve4:async()=>['192.0.32.10','127.0.0.1'],resolve6:async()=>[]}});await assert.rejects(bad.resolve('https://hooks.example.com/wake'),{reason:'address_not_allowed'});
});

test('Ed25519 signing binds URL and raw bytes and publishes public keys only',()=>{
  const keys=createWakeKeys(encoded,()=>Date.parse('2026-10-18T12:00:00Z'));const body='{"type":"wake.work_available"}';const url='https://hooks.example.com/wake';const headers=keys.sign(url,body,'wake_evt_one');
  const prefix=`envoi-wake/1\nwk_test\n${headers['envoi-wake-timestamp']}\nwake_evt_one\n${url}\n`;
  assert.equal(crypto.verify(null,Buffer.from(prefix+body),keyPair.publicKey,Buffer.from(headers['envoi-wake-signature'].slice(3),'base64url')),true);
  assert.equal(crypto.verify(null,Buffer.from(prefix+' '+body),keyPair.publicKey,Buffer.from(headers['envoi-wake-signature'].slice(3),'base64url')),false);
  assert.equal(keys.jwks().keys[0].d,undefined);assert.equal(keys.jwks().keys[0].status,'active');
});

test('transport pins checked address and host, handles upgrade and does not follow redirect',async()=>{
  let options;
  const transport=createWakeTransport({request:(_url,opts,callback)=>{options=opts;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const response=new EventEmitter();response.statusCode=302;response.headers={location:'http://127.0.0.1/secret'};response.destroy=()=>response.emit('close');callback(response);response.emit('close');};return req;}});
  const result=await transport({url:'https://hooks.example.com/wake',addresses:['192.0.32.10'],headers:{},bodyText:'{}'});assert.equal(result.failureClass,'redirect_rejected');assert.equal(options.servername,'hooks.example.com');assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.ok(options.ca.length);options.lookup('ignored',{all:true},(err,answers)=>{assert.equal(err,null);assert.deepEqual(answers,[{address:'192.0.32.10',family:4}]);});
  assert.equal(classifyWakeStatus(101),'http_rejected');assert.equal(classifyWakeStatus(410),'receiver_gone');
});

storeTest('durable destination limits coordinate instances and release slots',async(t,kind)=>{
  const h=await harness(t,kind);const one=createWakeAdmission({store:h.store,now:()=>100000});const two=createWakeAdmission({store:h.store,now:()=>100000});
  const base={host:'hooks.example.com',addresses:['192.0.32.10'],limited:true};assert.equal(await one.admit({...base,subscriptionId:'one',token:'one'}),true);assert.equal(await two.admit({...base,subscriptionId:'two',token:'two'}),true);assert.equal(await one.admit({...base,subscriptionId:'three',token:'three'}),false);await two.release('two');assert.equal(await one.admit({...base,subscriptionId:'three',token:'three'}),true);assert.equal(wakeNetwork('2001:4860:4860::8888'),'2001:4860:4860::/48');
});

test('transport rejects 101 upgrade and enforces connect and response deadlines',async()=>{
  let destroyed=false;
  const upgrade=createWakeTransport({request:()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>req.emit('upgrade',{statusCode:101},{destroy:()=>destroyed=true}));return req;}});
  assert.equal((await upgrade({url:'https://hooks.example.com/wake',addresses:['192.0.32.10'],headers:{},bodyText:'{}'})).failureClass,'http_rejected');assert.equal(destroyed,true);
  for(const secure of [false,true]){
    let aborted=false;
    const timeout=createWakeTransport({limits:{connectTimeoutMs:5,deliveryTimeoutMs:15,responseBodyReadMaxBytes:4096},request:()=>{const req=new EventEmitter();req.destroy=()=>aborted=true;req.end=()=>{if(secure){const socket=new EventEmitter();req.emit('socket',socket);socket.emit('secureConnect');}};return req;}});
    assert.equal((await timeout({url:'https://hooks.example.com/wake',addresses:['192.0.32.10'],headers:{},bodyText:'{}',remainingMs:15})).failureClass,'timeout');assert.equal(aborted,true);
  }
});

test('transport ignores response content, bounds bytes and accepts headers promptly',async()=>{
  let response,destroyed=false;
  const send=createWakeTransport({limits:{connectTimeoutMs:10,responseBodyReadMaxBytes:4},request:(_url,_opts,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{response=new EventEmitter();response.statusCode=204;response.headers={};response.destroy=()=>{destroyed=true;response.emit('close');};callback(response);};return req;}});
  assert.equal((await send({url:'https://hooks.example.com/wake',addresses:['192.0.32.10'],headers:{},bodyText:'{}',remainingMs:25})).status,204);
  response.emit('data',Buffer.from('1234'));assert.equal(destroyed,true);
});

test('DNS errors, empty replies, timeouts and own-address aliases are rejected',async()=>{
  const lookupError=Object.assign(new Error('resolver refused'),{code:'ESERVFAIL'});
  for(const resolver of [
    {resolve4:async()=>[],resolve6:async()=>[]},
    {resolve4:async()=>{throw lookupError;},resolve6:async()=>['2606:4700::1111']},
    {resolve4:()=>new Promise(()=>{}),resolve6:async()=>[]},
  ]){
    const checker=createWakeDestination({env:{},resolver,limits:{dnsTimeoutMs:3}});await assert.rejects(checker.resolve('https://hooks.example.com/wake'),{reason:'address_not_allowed'});
  }
  const alias=createWakeDestination({env:{ENVOI_PUBLIC_URL:'https://envoi-agents.com'},resolver:{resolve4:async()=>['192.0.32.10'],resolve6:async()=>[]}});await assert.rejects(alias.resolve('https://alias.attacker.com/wake'),{reason:'address_not_allowed'});
});

storeTest('revocation and pause during DNS prevent the actual external effect',async(t,kind)=>{
  for(const change of ['pause','revoke']){
    const h=await harness(t,kind);await h.active();h.beforeResolve(()=>{if(change==='pause')h.state.agent.status='paused';else h.state.family.revokedAt=h.options.now();});
    const before=h.sent.length;await h.service.runOnce();assert.equal(h.sent.length,before);
    const events=await h.store.listJson('http-wake/queue');assert.equal(events.find(e=>e.lane==='work').status,'cancelled');
  }
});

storeTest('stale queue fencing rejects a late result after interruption and another worker',async(t,kind)=>{
  const h=await harness(t,kind);await h.active();let entered,release;
  const started=new Promise(resolve=>entered=resolve);const blocked=new Promise(resolve=>release=resolve);
  h.beforeSend(async()=>{entered();await blocked;});
  const old=h.service.runOnce();await started;
  const first=(await h.store.listJson('http-wake/queue')).find(e=>e.lane==='work');assert.equal(first.status,'processing');
  h.advance(16000);const second=createHttpWake(h.options);await second.runOnce();
  const recovered=(await h.store.listJson('http-wake/queue')).find(e=>e.id===first.id);assert.equal(recovered.lastFailureClass,'interrupted');assert.equal(recovered.status,'retrying');
  release();await old;
  assert.equal((await h.store.listJson('http-wake/queue')).find(e=>e.id===first.id).status,'retrying','late success cannot settle the replacement lease');
  h.beforeSend(undefined);await second.runOnce();assert.equal((await h.store.listJson('http-wake/queue')).find(e=>e.id===first.id).status,'acknowledged');
  assert.equal(h.sent.at(-1).headers['envoi-wake-id'],first.id);
});

storeTest('two workers do not dispatch the same live lane and coalescing persists a follow-up',async(t,kind)=>{
  const h=await harness(t,kind);await h.active();let entered,release;const started=new Promise(resolve=>entered=resolve);const blocked=new Promise(resolve=>release=resolve);h.beforeSend(async()=>{entered();await blocked;});
  const first=h.service.runOnce();await started;
  await h.tx(()=>h.service.trigger({...identity,reason:'message_delivered'}));
  assert.equal(await createHttpWake(h.options).runOnce(),false);
  release();await first;h.beforeSend(undefined);await h.service.runOnce();
  const work=h.sent.filter(r=>JSON.parse(r.bodyText).type==='wake.work_available');assert.equal(work.length,2);assert.notEqual(work[0].headers['envoi-wake-id'],work[1].headers['envoi-wake-id']);
});

storeTest('changed self-host rules reject stored URL before DNS or transport',async(t,kind)=>{
  const h=await harness(t,kind);await h.active();let resolved=0;
  const changed=createHttpWake({...h.options,env:{...h.options.env,ENVOI_WAKE_SELF_HOSTS:'example.com'},resolveDestination:async()=>{resolved++;throw new Error('must not resolve');}});
  const before=h.sent.length;await changed.runOnce();assert.equal(resolved,0);assert.equal(h.sent.length,before);const event=(await h.store.listJson('http-wake/queue')).find(e=>e.lane==='work');assert.equal(event.lastFailureClass,'url_rejected');assert.equal(event.status,'failed');
});

storeTest('create limits count failed DNS and refused requests without doing another lookup',async(t,kind)=>{
  const h=await harness(t,kind);let lookups=0;
  const failing=createHttpWake({...h.options,resolveDestination:async()=>{lookups++;throw Object.assign(new Error('rejected'),{code:'WAKE_URL_REJECTED',reason:'address_not_allowed'});}});
  async function countAndCommit(){return h.tx(async()=>{try{return await failing.create(identity,{url:'https://hooks.example.com/wake'});}catch(error){return error;}});}
  for(let i=0;i<5;i++)assert.equal((await countAndCommit()).code,'WAKE_URL_REJECTED');
  const blocked=await countAndCommit();assert.equal(blocked.code,'RATE_LIMITED');assert.equal(blocked.retryAfter,3600);assert.equal(lookups,5);
  assert.equal((await h.store.getJson('http-wake/create-limits/agent_test.json')).entries.length,6);
  h.advance(3600001);assert.equal((await countAndCommit()).code,'WAKE_URL_REJECTED');assert.equal(lookups,6);
});

test('routine signing rotation changes signer at activeFrom and preserves retired verification',()=>{
  const next=crypto.generateKeyPairSync('ed25519');let clock=Date.parse('2026-10-18T12:00:00Z');
  const keys=createWakeKeys(JSON.stringify([
    {kid:'old',privateKey:keyPair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),activeFrom:'2026-10-01T00:00:00Z',notAfter:'2026-10-21T00:00:00Z'},
    {kid:'next',privateKey:next.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),activeFrom:'2026-10-20T00:00:00Z',notAfter:null}
  ]),()=>clock);
  assert.equal(keys.sign('https://hooks.example.com/wake','{}','wake_evt_one')['envoi-wake-key-id'],'old');assert.equal(keys.jwks().keys.find(k=>k.kid==='next').status,'next');clock=Date.parse('2026-10-20T00:00:00Z');assert.equal(keys.sign('https://hooks.example.com/wake','{}','wake_evt_one')['envoi-wake-key-id'],'next');assert.equal(keys.jwks().keys.find(k=>k.kid==='old').status,'retired');clock=Date.parse('2026-10-21T00:00:00Z');assert.equal(keys.jwks().keys.some(k=>k.kid==='old'),false);
});

storeTest('a DNS-stalled worker cannot send after its queue claim was recovered',async(t,kind)=>{
  const h=await harness(t,kind);await h.active();let entered,release;
  const started=new Promise(resolve=>entered=resolve);const blocked=new Promise(resolve=>release=resolve);
  h.beforeResolve(async()=>{entered();await blocked;});
  const before=h.sent.length;const old=h.service.runOnce();await started;
  h.advance(16000);await createHttpWake(h.options).runOnce();release();await old;
  assert.equal(h.sent.length,before,'expired worker must revalidate its queue token before transport');
  h.beforeResolve(undefined);await h.service.runOnce();assert.equal(h.sent.length,before+1);
});

storeTest('challenge activation during DNS suppresses the obsolete challenge send',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.tx(()=>h.service.create(identity,{url:'https://hooks.example.com/wake'}));
  const challenge=JSON.parse((await h.store.listJson('http-wake/queue'))[0].bodyText).challenge;
  let entered,release;const started=new Promise(resolve=>entered=resolve);const blocked=new Promise(resolve=>release=resolve);
  h.beforeResolve(async()=>{entered();await blocked;});h.advance(2000);
  const inFlight=h.service.runOnce();await started;
  await h.tx(()=>h.service.activate(identity,created.subscription.id,{challenge}));release();await inFlight;
  assert.equal(h.sent.length,0);h.beforeResolve(undefined);await h.service.runOnce();assert.equal(JSON.parse(h.sent[0].bodyText).type,'wake.work_available');
});

storeTest('cancelled and deadline-exceeded waiters cannot block the next receiver',async(t,kind)=>{
  const h=await harness(t,kind);let clock=100000;const admission=createWakeAdmission({store:h.store,now:()=>clock});
  const base={host:'shared.example.com',addresses:['192.0.32.10'],limited:true};
  await admission.admit({...base,subscriptionId:'one',token:'one'});await admission.admit({...base,subscriptionId:'two',token:'two'});
  await h.store.putJson('http-wake/queue/wake_evt_cancelled.json',{id:'wake_evt_cancelled',status:'queued',deadline:new Date(clock+60000).toISOString()});
  assert.equal(await admission.admit({...base,subscriptionId:'cancelled',eventId:'wake_evt_cancelled',token:'cancelled'}),false);
  await h.store.putJson('http-wake/queue/wake_evt_cancelled.json',{id:'wake_evt_cancelled',status:'cancelled',deadline:new Date(clock+60000).toISOString()});
  await admission.release('one');await admission.release('two');
  assert.equal(await admission.admit({...base,subscriptionId:'next',token:'next'}),true);
  await admission.admit({...base,subscriptionId:'occupy',token:'occupy'});
  await h.store.putJson('http-wake/queue/wake_evt_expired.json',{id:'wake_evt_expired',status:'queued',deadline:new Date(clock+1).toISOString()});
  assert.equal(await admission.admit({...base,subscriptionId:'expired',eventId:'wake_evt_expired',token:'expired'}),false);
  clock+=2;await admission.release('next');await admission.release('occupy');
  assert.equal(await admission.admit({...base,subscriptionId:'last',token:'last'}),true);
});

test('response body drain retains its slot and the original whole-attempt deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let callback,response,destroyed=false,settled=false;
  const send=createWakeTransport({request:(_url,_opts,cb)=>{callback=cb;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{};return req;}});
  const pending=send({url:'https://hooks.example.com/wake',addresses:['192.0.32.10'],headers:{},bodyText:'{}',remainingMs:100}).then(result=>{settled=true;return result;});
  t.mock.timers.tick(75);
  response=new EventEmitter();response.statusCode=204;response.headers={};response.destroy=()=>{destroyed=true;response.emit('close');};callback(response);
  await Promise.resolve();assert.equal(settled,false,'headers acknowledge but do not free the socket/admission slot');
  t.mock.timers.tick(25);const result=await pending;assert.equal(result.status,204);assert.equal(destroyed,true);
});
