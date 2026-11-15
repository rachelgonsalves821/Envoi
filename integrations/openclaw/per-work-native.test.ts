import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';import fixture from './native-observer-sources.fixture.json';
import {CLOSED_NATIVE_BOOTSTRAP_FILES,CLOSED_NATIVE_POLICY_FILES} from './closed-native-bootstrap';
import {prepareOwnedOpenClawFactory,assertOwnedOpenClawFactory,prepareOwnedOpenClawWork,startOwnedOpenClawWork,reserveOwnedOpenClawWork,bindReservedOpenClawWork} from './per-work-native';
import {approveOpenClawPreclaim,openClawPreclaimDigest} from './preclaim-selection';
import {createServer} from 'node:net';
const fake=vi.hoisted(()=>({start:vi.fn(async()=>({authority:{FAKE_OFFLINE:true}}))}));
vi.mock('./owned-native-process',async original=>({...await original<any>(),startOwnedClosedNativeProcess:fake.start}));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)){const p=path.resolve(root);if(!p.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(p).startsWith('envoi-native-prep-'))throw Error('TEST_CLEANUP_REFUSED');await fs.rm(p,{recursive:true,force:true});}fake.start.mockClear();});
async function setup(){const root=await fs.mkdtemp(path.join(tmpdir(),'envoi-native-prep-'));roots.push(root);const native=path.join(root,'original-code'),profile=path.join(root,'original-profile'),entry=path.join(root,'child.mjs');
 for(const[role,name]of Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES)){if(role==='observer')continue;const file=path.join(native,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,(fixture.files as any)[path.basename(file)]??'FAKE_CODE_'+role);}
 for(const name of['package.json','node_modules/@openclaw/ai/package.json']){const file=path.join(native,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'{"version":"2026.10.5"}');}
 await fs.mkdir(profile);await fs.mkdir(path.join(profile,'envoi-state'));await fs.writeFile(path.join(profile,'envoi-state','history'),'ORIGINAL_ENROLLMENT_HISTORY');
 await fs.writeFile(path.join(profile,'openclaw.json'),JSON.stringify({models:{providers:{anthropic:{apiKey:'FAKE_NATIVE_PRIVATE_API_KEY',headers:{'x-original-auth':'FAKE_PRIVATE_AUTH'},models:[{id:'claude-haiku-4-5-20251001',maxTokens:4096}]}}},gateway:{auth:{token:'FAKE_OLD_GATEWAY_TOKEN'}}}));await fs.writeFile(entry,'FAKE_CHILD_CODE');
 const options={sourceNativeRoot:native,destinationNativeRoot:path.join(root,'prepared-code'),workRoot:path.join(root,'works'),originalProfile:profile,nodeExecutable:'FAKE_NODE',nativeEnvironmentFile:path.join(root,'FAKE_NATIVE_OWNED_ENVFILE'),childEntry:entry,childEntrySha256:hash('FAKE_CHILD_CODE'),clientSource:'a'.repeat(40),factoryPolicySha256:'b'.repeat(64),authorize:vi.fn(async()=>{})};return{root,profile,native,options};}
it('prepares and revalidates an actual separate code copy without starting a gateway or inventing work scope',async()=>{
 const s=await setup(),original=await fs.readFile(path.join(s.native,'dist/model-registry-Bc1CKDx-.mjs'));const{factory,pins}=await prepareOwnedOpenClawFactory(s.options);
 expect(await fs.readFile(path.join(s.native,'dist/model-registry-Bc1CKDx-.mjs'))).toEqual(original);expect(await fs.readFile(path.join(s.options.destinationNativeRoot,'dist/model-registry-Bc1CKDx-.mjs'),'utf8')).toContain('createNodeLlmRuntime(apiRegistry,observer.transportHost)');
 expect(await assertOwnedOpenClawFactory(factory,pins,new AbortController().signal)).toMatchObject({kind:'actual_prepared_native_factory',nativeGatewayStarted:false,modelPromptsSubmitted:0});expect(fake.start).not.toHaveBeenCalled();
 await expect(assertOwnedOpenClawFactory({}as any,pins,new AbortController().signal)).rejects.toThrow('PREPARED_OWNED_NATIVE_FACTORY_REQUIRED');
 const manifest=path.join(s.options.destinationNativeRoot,'envoi-native-source-copy.json'),saved=JSON.parse(await fs.readFile(manifest,'utf8'));saved.sources=Object.fromEntries(Object.entries(saved.sources).filter(([key])=>!Object.hasOwn(CLOSED_NATIVE_POLICY_FILES,key)));const legacyBytes=JSON.stringify(saved);await fs.writeFile(manifest,legacyBytes);const reaudited=await prepareOwnedOpenClawFactory(s.options);expect(reaudited.pins).toEqual(pins);expect(await fs.readFile(manifest,'utf8')).toBe(legacyBytes);
 await fs.writeFile(path.join(s.options.destinationNativeRoot,'unreviewed-transitive-module.js'),'DRIFT');await expect(prepareOwnedOpenClawFactory(s.options)).rejects.toThrow('PREPARED_NATIVE_SOURCE_COPY_DRIFT');
 await fs.writeFile(path.join(s.options.destinationNativeRoot,CLOSED_NATIVE_POLICY_FILES.anthropicTransport),'CHANGED_TRANSPORT');await expect(assertOwnedOpenClawFactory(factory,pins,new AbortController().signal)).rejects.toThrow('OWNED_NATIVE_FACTORY_SOURCE_DRIFT');
});
it('rejects canonical same/nested copy paths and original-profile nesting before creating destinations',async()=>{
 const s=await setup();for(const destination of[path.join(s.native,'.'),path.join(s.native,'child-copy'),s.root])await expect(prepareOwnedOpenClawFactory({...s.options,destinationNativeRoot:destination})).rejects.toThrow(/SEPARATE_NATIVE_PACKAGE_COPY_REQUIRED|DISJOINT_NATIVE_COPY_PATHS_REQUIRED/);
 await expect(prepareOwnedOpenClawFactory({...s.options,workRoot:s.root})).rejects.toThrow('DISJOINT_NATIVE_COPY_PATHS_REQUIRED');expect(await fs.readFile(path.join(s.native,'package.json'),'utf8')).toBe('{"version":"2026.10.5"}');
 await expect(prepareOwnedOpenClawFactory({...s.options,workRoot:path.join(s.native,'private-work')})).rejects.toThrow('DISJOINT_NATIVE_COPY_PATHS_REQUIRED');await expect(fs.access(s.options.destinationNativeRoot)).rejects.toMatchObject({code:'ENOENT'});await expect(fs.access(path.join(s.native,'private-work'))).rejects.toMatchObject({code:'ENOENT'});
});
it('copies private native config only, preserves provider auth/model and original enrollment, and invokes actual allocator with exact per-work pins',async()=>{
 const s=await setup(),original=await fs.readFile(path.join(s.profile,'openclaw.json')),{factory,pins}=await prepareOwnedOpenClawFactory(s.options),signal=new AbortController().signal;
 const binding={window:'c'.repeat(64),workId:'msg_actual',caseId:'case_actual',caseSessionId:'case_session_actual',toolChannelSha256:'d'.repeat(64),processIdentity:'process_actual',stateDirectorySha256:'e'.repeat(64),configurationPathSha256:'e'.repeat(64),workspaceSha256:'e'.repeat(64),agentStateSha256:'e'.repeat(64),nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:42001',hardStopUnixMs:Date.now()+120000,nativeSources:{}};
 const canonical={recipientAgentId:'agent_original',installationId:'installation_original',fence:1};
 const prepared=await prepareOwnedOpenClawWork(factory,{binding,canonical,gatewayPort:41001,proxyToken:'FAKE_PRIVATE_PROXY_TOKEN',proxyIdentity:'proxy_actual',signal});
 const config=JSON.parse(await fs.readFile(path.join(s.options.workRoot,'msg_actual','openclaw.json'),'utf8'));expect(config.models.providers.anthropic.apiKey).toBe('FAKE_NATIVE_PRIVATE_API_KEY');expect(config.models.providers.anthropic.headers['x-original-auth']).toBe('FAKE_PRIVATE_AUTH');expect(config.models.providers.anthropic.models[0].maxTokens).toBe(4096);
 expect(config.agents).not.toHaveProperty('list');expect(config.agents.entries).toEqual({main:{workspace:path.join(s.options.workRoot,'msg_actual','workspace'),agentDir:path.join(s.options.workRoot,'msg_actual','agent-state')}});
 expect(await fs.readFile(path.join(s.profile,'openclaw.json'))).toEqual(original);expect(await fs.readFile(path.join(s.profile,'envoi-state','history'),'utf8')).toBe('ORIGINAL_ENROLLMENT_HISTORY');expect(await fs.readdir(path.join(s.options.workRoot,'msg_actual','state'))).toEqual([]);
 await startOwnedOpenClawWork(factory,prepared.prepared,{canonical,capabilitySha256:'1'.repeat(64),ownerSelectionSha256:'2'.repeat(64),meterToken:'FAKE_NATIVE_METER_TOKEN',environment:{},signal,authorize:vi.fn(async()=>{}),ports:{}as any});
 expect(fake.start).toHaveBeenCalledTimes(1);const actual=fake.start.mock.calls[0][0]as any;expect(actual.pins).toMatchObject({workId:binding.workId,caseSessionId:binding.caseSessionId,capabilitySha256:'1'.repeat(64),nativeSourceSha256:pins.nativeSourceSha256});expect(actual.nativeEnvironmentFile).toBe(s.options.nativeEnvironmentFile);expect(actual.bootstrap.binding.nativeSources.packageTree).toMatch(/^[a-f0-9]{64}$/);expect(actual.environment.OPENCLAW_CONFIG_PATH).toBe(path.join(s.options.workRoot,'msg_actual','openclaw.json'));expect(actual.environment).not.toHaveProperty('OPENCLAW_DISABLE_BUNDLED_PLUGINS');
 await expect(prepareOwnedOpenClawWork(factory,{binding,canonical,gatewayPort:41002,proxyToken:'fake',proxyIdentity:'proxy_duplicate',signal})).rejects.toThrow('NEW_EXACT_NATIVE_WORK_REQUIRED');
});
it('preserves an earlier attempt profile and supports the same logical work in a caller-pinned fresh attempt root',async()=>{
 const s=await setup(),signal=new AbortController().signal,binding={window:'c'.repeat(64),workId:'msg_retained',caseId:'case_retained',caseSessionId:'case_session_first',toolChannelSha256:'d'.repeat(64),processIdentity:'process_first',stateDirectorySha256:'e'.repeat(64),configurationPathSha256:'e'.repeat(64),workspaceSha256:'e'.repeat(64),agentStateSha256:'e'.repeat(64),nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:42001',hardStopUnixMs:Date.now()+120000,nativeSources:{}},canonical={recipientAgentId:'agent_original',installationId:'installation_original',fence:1};
 const first=await prepareOwnedOpenClawFactory(s.options),input={binding,canonical,gatewayPort:41001,proxyToken:'FAKE_PRIVATE_TOKEN',proxyIdentity:'proxy_first',signal};
 await prepareOwnedOpenClawWork(first.factory,input);
 const oldRoot=path.join(s.options.workRoot,binding.workId),files=['openclaw.json','original-config.private.backup.json'],before=await Promise.all(files.map(file=>fs.readFile(path.join(oldRoot,file))));
 const reopened=await prepareOwnedOpenClawFactory(s.options);await expect(prepareOwnedOpenClawWork(reopened.factory,input)).rejects.toMatchObject({code:'EEXIST'});
 const fresh=await prepareOwnedOpenClawFactory({...s.options,workRoot:path.join(s.options.workRoot,'attempt-reviewed-2'),directClientTools:true}),next={...binding,caseSessionId:'case_session_retry',processIdentity:'process_retry'};
 const prepared=await prepareOwnedOpenClawWork(fresh.factory,{...input,binding:next,canonical:{...canonical,fence:2},gatewayPort:41002,proxyIdentity:'proxy_retry'});
 expect(prepared.privateTarget.binding).toMatchObject({workId:binding.workId,caseId:binding.caseId,caseSessionId:next.caseSessionId,fence:2});
 for(let i=0;i<files.length;i++)expect(await fs.readFile(path.join(oldRoot,files[i]))).toEqual(before[i]);
 expect(prepared.privateTarget.configurationPathSha256).not.toBe(hash(path.resolve(path.join(oldRoot,'openclaw.json'))));
 const retryConfig=JSON.parse(await fs.readFile(path.join(s.options.workRoot,'attempt-reviewed-2',binding.workId,'openclaw.json'),'utf8'));
 expect(retryConfig.tools).toEqual({profile:'minimal',deny:['*'],toolSearch:false});
 expect(await fs.readFile(path.join(s.profile,'envoi-state','history'),'utf8')).toBe('ORIGINAL_ENROLLMENT_HISTORY');expect(fake.start).not.toHaveBeenCalled();
 await expect(prepareOwnedOpenClawWork(fresh.factory,{...input,binding:next,canonical:{...canonical,fence:2}})).rejects.toThrow('NEW_EXACT_NATIVE_WORK_REQUIRED');
 await startOwnedOpenClawWork(fresh.factory,prepared.prepared,{canonical:{...canonical,fence:2},capabilitySha256:'1'.repeat(64),ownerSelectionSha256:'2'.repeat(64),meterToken:'FAKE_NATIVE_METER_TOKEN',environment:{OPENCLAW_DISABLE_BUNDLED_PLUGINS:'0'},signal,authorize:async()=>{},ports:{}as any});
 expect(fake.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({environment:expect.objectContaining({OPENCLAW_DISABLE_BUNDLED_PLUGINS:'1',OPENCLAW_GATEWAY_STARTUP_TRACE:'1'})}));
});

async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address()as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));return port;}
it('reserves the exact inert port/config before review, waits without a lease, then binds and starts one fresh scope',async()=>{
 const s=await setup(),{factory}=await prepareOwnedOpenClawFactory(s.options),stop=new AbortController(),signal=stop.signal,port=await freePort();
 const reserved=await reserveOwnedOpenClawWork(factory,{binding:{window:'c'.repeat(64),workId:'msg_preclaim',caseId:'case_same',processIdentity:'process_preclaim',nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:42001'},canonical:{recipientAgentId:'agent_original',installationId:'installation_original',inboxId:'inbox_original'},gatewayPort:port,proxyToken:'FAKE_PRIVATE_PROXY',proxyIdentity:'proxy_preclaim',signal});
 try{
  expect(fake.start).not.toHaveBeenCalled();expect(reserved.privateTarget).not.toHaveProperty('caseSessionId');expect(reserved.privateTarget).not.toHaveProperty('deadlineUnixMs');
  const before=await fs.readFile(path.join(s.options.workRoot,'msg_preclaim','openclaw.json'));
  const contender=createServer();await expect(new Promise<void>((resolve,reject)=>{contender.once('error',reject);contender.listen(port,'127.0.0.1',resolve);})).rejects.toMatchObject({code:'EADDRINUSE'});
  const raw=JSON.stringify({purpose:'phase-c-personal-preclaim-native-selection',version:1,ownerApproved:true,lifetime:'one-claim-until-cancel',subjectHash:openClawPreclaimDigest(reserved.privateTarget),window:reserved.privateTarget.binding.window,clientSource:reserved.privateTarget.clientSource,nativeSourceSha256:reserved.privateTarget.nativeSourceSha256,approvedAtUtc:new Date().toISOString()});
  const approval=approveOpenClawPreclaim(reserved.privateTarget,raw,signal),later=Date.now()+72*3600000;vi.spyOn(Date,'now').mockReturnValue(later);
  const input={approval,canonical:{recipientAgentId:'agent_original',installationId:'installation_original',fence:4},caseSessionId:'case_session_fresh',toolChannelSha256:'d'.repeat(64),deadlineUnixMs:later+120000,signal};
  const bound=await bindReservedOpenClawWork(factory,reserved.reservation,input);expect(fake.start).not.toHaveBeenCalled();expect(bound.selection.caseSessionId).toBe('case_session_fresh');expect(await fs.readFile(path.join(s.options.workRoot,'msg_preclaim','openclaw.json'))).toEqual(before);
  expect(JSON.parse(await fs.readFile(path.join(s.options.workRoot,'msg_preclaim','preclaim-consent.used.json'),'utf8')).targetSha256).toBe(bound.selection.targetSha256);
  await expect(bindReservedOpenClawWork(factory,reserved.reservation,input)).rejects.toThrow('EXACT_NATIVE_RESERVATION_REQUIRED');
  const startOptions={canonical:input.canonical,capabilitySha256:bound.capability.capabilitySha256,ownerSelectionSha256:bound.selection.receiptSha256,meterToken:'FAKE_METER',environment:{},signal,authorize:async()=>{},ports:{}as any};const firstStart=startOwnedOpenClawWork(factory,bound.prepared,startOptions);await expect(startOwnedOpenClawWork(factory,bound.prepared,startOptions)).rejects.toThrow('EXACT_PREPARED_NATIVE_WORK_REQUIRED');await firstStart;expect(fake.start).toHaveBeenCalledTimes(1);
  expect((fake.start.mock.calls[0][0]as any).bootstrap.binding).toMatchObject({caseSessionId:'case_session_fresh',hardStopUnixMs:later+120000});
 }finally{stop.abort();await reserved.close();}
});
it('does not bind a changed reviewed configuration or start native code',async()=>{
 const s=await setup(),{factory}=await prepareOwnedOpenClawFactory(s.options),stop=new AbortController(),port=await freePort();
 const r=await reserveOwnedOpenClawWork(factory,{binding:{window:'c'.repeat(64),workId:'msg_changed_config',caseId:'case_same',processIdentity:'process_preclaim',nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:42001'},canonical:{recipientAgentId:'agent_original',installationId:'installation_original',inboxId:'inbox_original'},gatewayPort:port,proxyToken:'FAKE',proxyIdentity:'proxy_preclaim',signal:stop.signal});
 try{const approval=approveOpenClawPreclaim(r.privateTarget,JSON.stringify({purpose:'phase-c-personal-preclaim-native-selection',version:1,ownerApproved:true,lifetime:'one-claim-until-cancel',subjectHash:openClawPreclaimDigest(r.privateTarget),window:r.privateTarget.binding.window,clientSource:r.privateTarget.clientSource,nativeSourceSha256:r.privateTarget.nativeSourceSha256,approvedAtUtc:new Date().toISOString()}),stop.signal);
  await fs.appendFile(path.join(s.options.workRoot,'msg_changed_config','openclaw.json'),' ');
  await expect(bindReservedOpenClawWork(factory,r.reservation,{approval,canonical:{recipientAgentId:'agent_original',installationId:'installation_original',fence:4},caseSessionId:'case_session_fresh',toolChannelSha256:'d'.repeat(64),deadlineUnixMs:Date.now()+120000,signal:stop.signal})).rejects.toThrow('PRECLAIM_NATIVE_CONFIGURATION_CHANGED');expect(fake.start).not.toHaveBeenCalled();
 }finally{stop.abort();await r.close();}
});
