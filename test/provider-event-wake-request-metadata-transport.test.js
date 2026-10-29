// Real HTTP parsing/dispatch with the canonical Events service; OAuth/lifecycle gates remain in the existing server suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {handleAgentMcp} from '../src/agent-mcp.js';
import {createProviderEventWake} from '../src/provider-event-wake.js';

const identity={inboxId:'inbox_metadata_http',agent:{id:'agent_metadata_http',permissions:['receive_agent_messages']},family:{id:'family_metadata_http',audience:'https://envoi.example/mcp'},installationId:'installation_metadata_http'};
const root=new URL('./contract-fixtures/provider-event-wake-request-metadata/',import.meta.url);
const registry=JSON.parse(await readFile(new URL('./contract-fixtures/index.json',import.meta.url),'utf8'));
const entry=registry.contracts.find(row=>row.id==='provider-event-wake-request-metadata');
const fixtures=await Promise.all(entry.fixtures.map(name=>readFile(new URL(name,root),'utf8').then(JSON.parse)));
async function start(t){
  const deleted=[];let caller=identity;
  const provider=createProviderEventWake({httpWake:{registerProfile(){},profileRecords:async()=>[]},store:{deleteJson:async key=>deleted.push(key)},mcpEventsEnabled:true,key:Buffer.alloc(32,7),env:{}});
  const server=http.createServer(async(req,res)=>{
    try{await handleAgentMcp(req,res,{identity:caller,providerEvents:provider,eventsEnabled:true,callRest:async()=>{throw Error('not a tool call');}});}
    catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({unexpected:true}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const post=async(method,params,version='2026-07-28')=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version},body:JSON.stringify({jsonrpc:'2.0',id:7,method,params})});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  return {post,deleted,setCaller:value=>caller=value};
}
test('real HTTP Events requests consume metadata vectors and retain closed arguments and callback refusal',async t=>{
  const h=await start(t);
  for(const fixture of fixtures){
    const before=h.deleted.length,response=await h.post(fixture.method,fixture.params);
    assert.equal(response.status,200,fixture.id);assert.equal(response.headers.get('cache-control'),'no-store');
    if(!fixture.expected.valid){assert.deepEqual(response.body,{jsonrpc:'2.0',id:7,error:{code:-32602,message:'Invalid params'}},fixture.id);assert.equal(h.deleted.length,before);}
    else if(fixture.method==='events/list')assert.deepEqual(response.body.result.events.map(row=>row.name),['envoi.work_available','envoi.control_changed']);
    else if(fixture.method==='events/subscribe')assert.deepEqual(response.body.error,{code:-32015,message:'CallbackEndpointError',data:{reason:'origin_not_allowed'}});
    else assert.deepEqual(response.body.result,{});
    assert.equal(JSON.stringify([response.body,h.deleted]).includes('METADATA_ONLY_SYNTHETIC'),false);
  }
});
test('real HTTP request limit and qualification precede malformed metadata',async t=>{
  const h=await start(t);
  const boundaryParams={_meta:{padding:''}};
  const envelopeBytes=Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:7,method:'events/list',params:boundaryParams}));
  boundaryParams._meta.padding='x'.repeat(65536-envelopeBytes);
  const boundary=await h.post('events/list',boundaryParams);assert.equal(boundary.status,200);assert.equal(boundary.body.result.events.length,2);
  const oversized=await h.post('events/list',{_meta:{padding:'x'.repeat(65536)}});assert.equal(oversized.status,413);assert.equal(oversized.body.error.code,-32600);
  for(const method of ['events/list','events/subscribe','events/unsubscribe']){
    const old=await h.post(method,{_meta:null},'2025-11-25');assert.equal(old.status,200);assert.equal(old.body.error.code,-32601);
  }
  h.setCaller({...identity,mcpScope:{caseId:'synthetic'}});
  const scoped=await h.post('events/list',{_meta:null});assert.equal(scoped.body.error.code,-32601);
  h.setCaller({...identity,agent:{...identity.agent,permissions:[]}});
  const unqualified=await h.post('events/subscribe',{_meta:null});assert.equal(unqualified.body.error.code,-32601);
  assert.deepEqual(h.deleted,[]);
});
