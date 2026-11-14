import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {nativeStartupDiagnostic,readNativeStartupDiagnostic,tagNativeStartupFailure,ownedNativeStartupError} from './native-startup-diagnostics';
import {startClosedNativeGateway,CLOSED_NATIVE_BOOTSTRAP_FILES} from './closed-native-bootstrap';
import {startOwnedClosedNativeProcess,closedNativeManifestDigest,assertOwnedClosedNativeAuthority} from './owned-native-process';
import type {ClosedNativeBinding} from './closed-native-owner';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const secret='INERT_PRIVATE_PATH_OR_CREDENTIAL_MUST_NOT_ESCAPE';
function fixture(){
 const paths={stateDirectory:path.resolve('inert/state'),configurationPath:path.resolve('inert/config'),workspace:path.resolve('inert/workspace'),agentState:path.resolve('inert/agent')};
 const sourceSha256=Object.fromEntries(Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES).map(key=>[key,hash(key)])) as any;
 const binding:ClosedNativeBinding={window:'a'.repeat(64),workId:'inert-work',caseId:'inert-case',caseSessionId:'inert-session',toolChannelSha256:'b'.repeat(64),processIdentity:'inert-process',
  stateDirectorySha256:hash(paths.stateDirectory),configurationPathSha256:hash(paths.configurationPath),workspaceSha256:hash(paths.workspace),agentStateSha256:hash(paths.agentState),
  nativeAgentId:'main',modelId:'inert-model',proxyOrigin:'http://127.0.0.1:1',hardStopUnixMs:Date.now()+90000,nativeSources:{...sourceSha256,packageTree:'c'.repeat(64)}};
 const ports={assertLive:vi.fn(),assertEffectiveConfiguration:vi.fn(),recordObservation:vi.fn(async()=>{}),authorizePhysical:vi.fn(async()=>{}),recordPhysicalOutcome:vi.fn(async()=>{})};
 let installed:any,host:any={buildModelFetch:()=>vi.fn()};
 const close=vi.fn(async()=>{}),start=vi.fn(async()=>({close,startupSettled:Promise.resolve()}));
 const loadModule=vi.fn(async(file:string)=>{
  const role=Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,relative])=>file.endsWith(path.normalize(relative)))![0];
  if(role==='host')return{getDefaultAiTransportHost:()=>host,configureAiTransportHost:(next:any)=>{host=next;}};
  if(role==='observer')return{installClosedNativeObserver:(next:any)=>{installed=next;},getClosedNativeObserver:()=>installed};
  if(role==='config')return{r:()=>({}),i:()=>({})};if(role==='plugins')return{l:()=>({plugins:[],providers:[],agentHarnesses:[]}),m:()=>[]};
  if(role==='server')return{startGatewayServer:start};return{};
 });
 return{binding,paths,ports,start,close,loadModule,options:{nativeRoot:path.resolve('inert/native'),binding,paths,port:19000,sourceSha256,authorize:vi.fn(async()=>{}),ports},
  deps:{readPathEnvironment:()=>paths,readBytes:vi.fn(async(file:string)=>Buffer.from(Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,relative])=>file.endsWith(path.normalize(relative)))![0])),loadModule}};
}
it.each(['ENOENT','EPERM','EADDRINUSE','ERR_MODULE_NOT_FOUND'])('retains allowlisted system code %s without its private message or stack',code=>{
 const error=Object.assign(new Error(secret),{code,stack:secret,config:secret,cause:{message:secret}});
 expect(tagNativeStartupFailure(error,'import-config')).toBe(error);
 expect(nativeStartupDiagnostic(error)).toEqual({version:1,stage:'import-config',reason:code});
 expect(JSON.stringify(ownedNativeStartupError(nativeStartupDiagnostic(error)))).not.toContain(secret);
});
it('never evaluates exception accessors, toJSON, arbitrary cause trees or unknown error strings',()=>{
 const getter=vi.fn(()=>{throw Error(secret);}),error=Object.defineProperties({toJSON:getter,cause:{message:secret}},{message:{get:getter},code:{get:getter}});
 expect(nativeStartupDiagnostic(tagNativeStartupFailure(error,'configuration'))).toEqual({version:1,stage:'configuration',reason:'NATIVE_STARTUP_UNCLASSIFIED'});
 expect(getter).not.toHaveBeenCalled();
 expect(nativeStartupDiagnostic(new Error('ENOENT '+secret))).toEqual({version:1,stage:'unknown',reason:'NATIVE_STARTUP_UNCLASSIFIED'});
 expect(nativeStartupDiagnostic(tagNativeStartupFailure(secret,'source-validation'))).toEqual({version:1,stage:'source-validation',reason:'NATIVE_STARTUP_UNCLASSIFIED'});
 expect(nativeStartupDiagnostic(tagNativeStartupFailure(new Error(secret),secret as any),secret as any)).toEqual({version:1,stage:'unknown',reason:'NATIVE_STARTUP_UNCLASSIFIED'});
});
it.each([
 undefined,null,{}, {version:2,stage:'import-host',reason:'ENOENT'}, {version:1,stage:secret,reason:'ENOENT'},
 {version:1,stage:'import-host',reason:secret},{version:1,stage:'import-host',reason:'ENOENT',raw:secret},
])('rejects malformed or extended IPC diagnostics rather than copying them',value=>{
 const parsed=readNativeStartupDiagnostic(value);expect(parsed).toEqual({version:1,stage:'unknown',reason:'NATIVE_STARTUP_UNCLASSIFIED'});expect(Object.isFrozen(parsed)).toBe(true);
 expect(ownedNativeStartupError(value).message).not.toContain(secret);
});
it.each([
 ['authorization','NATIVE_DEADLINE_EXPIRED'],['private-paths','REVIEWED_NATIVE_PRIVATE_PATH_REQUIRED'],
 ['source-validation','REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED'],['import-host','ERR_MODULE_NOT_FOUND'],
 ['configuration','ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED'],['configuration','INVALID_CONFIG'],['gateway-start','EADDRINUSE'],
] as const)('attributes production bootstrap refusal at %s and never converts failure into readiness',async(stage,reason)=>{
 const f=fixture();let original:unknown;
 if(stage==='authorization')f.ports.assertLive.mockImplementation(()=>{throw original=new Error(reason);});
 if(stage==='private-paths')f.options.paths={...f.paths,stateDirectory:path.resolve(secret)};
 if(stage==='source-validation')f.deps.readBytes.mockResolvedValue(Buffer.from(secret));
 if(stage==='import-host')f.loadModule.mockRejectedValue(original=Object.assign(new Error(secret),{code:reason}));
 if(stage==='configuration')f.ports.assertEffectiveConfiguration.mockImplementation(()=>{throw original=new Error(reason);});
 if(stage==='gateway-start')f.start.mockRejectedValue(original=Object.assign(new Error(secret),{code:reason}));
 let caught:unknown;try{await startClosedNativeGateway(f.options,f.deps);}catch(error){caught=error;}
 expect(caught).toBeDefined();if(original)expect(caught).toBe(original);
 expect(nativeStartupDiagnostic(caught)).toEqual({version:1,stage,reason});
 expect(f.ports.authorizePhysical).not.toHaveBeenCalled();expect(f.ports.recordObservation).not.toHaveBeenCalled();
 if(['authorization','private-paths','source-validation'].includes(stage))expect(f.loadModule).not.toHaveBeenCalled();
 if(stage!=='gateway-start')expect(f.start).not.toHaveBeenCalled();
});
it('keeps the successful pending-first-harness readiness and cleanup path unchanged',async()=>{
 const f=fixture(),gateway=await startClosedNativeGateway(f.options,f.deps);
 expect(gateway.readiness()).toMatchObject({runtimeObservation:'pending_first_harness'});expect(gateway.snapshot()).toBeUndefined();
 expect(f.start).toHaveBeenCalledOnce();await gateway.close();expect(f.close).toHaveBeenCalledOnce();expect(f.ports.authorizePhysical).not.toHaveBeenCalled();
});
it('runs reviewed file reads in parallel and stops before import when the work expires during verification',async()=>{
 const f=fixture(),read=f.deps.readBytes.getMockImplementation()!,stages:string[]=[];
 let release!:()=>void,allReadsStarted!:()=>void,expired=false;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const started=new Promise<void>(resolve=>{allReadsStarted=resolve;});
 f.deps.readBytes.mockImplementation(async file=>{
  if(f.deps.readBytes.mock.calls.length===Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES).length)allReadsStarted();
  if(file===path.join(f.options.nativeRoot,CLOSED_NATIVE_BOOTSTRAP_FILES.package))await blocked;
  return read(file);
 });
 f.ports.assertLive.mockImplementation(()=>{if(expired)throw Error('NATIVE_DEADLINE_EXPIRED');});
 const boot=startClosedNativeGateway(f.options,f.deps,stage=>stages.push(stage));
 await started;
 expect(f.loadModule).not.toHaveBeenCalled();
 expired=true;
 release();
 await expect(boot).rejects.toThrow('NATIVE_DEADLINE_EXPIRED');
 expect(stages).toEqual(['authorization','private-paths','source-validation','import-host']);
 expect(f.loadModule).not.toHaveBeenCalled();
});
it('closes the gateway if the work expires before native startup settles',async()=>{
 const f=fixture();
 let release!:()=>void,settling!:()=>void,expired=false;
 const startupSettled=new Promise<void>(resolve=>{release=resolve;});
 const entered=new Promise<void>(resolve=>{settling=resolve;});
 f.start.mockResolvedValue({close:f.close,startupSettled});
 f.ports.assertLive.mockImplementation(()=>{if(expired)throw Error('NATIVE_DEADLINE_EXPIRED');});
 const boot=startClosedNativeGateway(f.options,f.deps,stage=>{if(stage==='gateway-settle')settling();});
 await entered;
 expired=true;
 release();
 await expect(boot).rejects.toThrow('NATIVE_DEADLINE_EXPIRED');
 expect(f.close).toHaveBeenCalledOnce();
 expect(f.ports.authorizePhysical).not.toHaveBeenCalled();
});
class FailedChild extends EventEmitter{
 pid=123;exitCode:number|null=null;connected=true;sent:any[]=[];
 constructor(private diagnostic:unknown,private foreignFirst=false){super();}
 send(message:any){this.sent.push(message);if(message.kind==='start')queueMicrotask(()=>{
  if(this.foreignFirst)this.emit('message',{kind:'failed',nonce:'f'.repeat(64),diagnostic:{version:1,stage:'gateway-start',reason:'EADDRINUSE'}});
  this.emit('message',{kind:'failed',nonce:message.nonce,diagnostic:this.diagnostic});
 });return true;}
 kill(){this.exitCode=1;this.connected=false;this.emit('exit',1);return true;}
}
it.each([true,false])('only accepts the owned nonce and sanitized diagnostic, then stops the child (valid=%s)',async valid=>{
 const f=fixture(),pins={window:f.binding.window,workId:f.binding.workId,caseId:f.binding.caseId,caseSessionId:f.binding.caseSessionId,toolChannelSha256:f.binding.toolChannelSha256,processIdentity:f.binding.processIdentity,
  clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(f.binding.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)};
 const child=new FailedChild(valid?{version:1,stage:'import-config',reason:'ERR_MODULE_NOT_FOUND'}:{version:1,stage:secret,reason:secret},true),signal=new AbortController().signal;
 let caught:any;try{await startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:hash('entry'),environment:{},bootstrap:f.options,pins,
  meterBinding:{nativeToken:'inert-token',deadlineUnixMs:f.binding.hardStopUnixMs},authorize:async()=>{},ports:f.ports,signal},
  {readBytes:async()=>Buffer.from('entry'),spawnChild:()=>child as any,nonce:()=> 'a'.repeat(64)});}catch(error){caught=error;}
 expect(caught.code).toBe('OWNED_NATIVE_CHILD_FAILED');expect(caught.nativeStartupDiagnostic).toEqual(valid?{version:1,stage:'import-config',reason:'ERR_MODULE_NOT_FOUND'}:{version:1,stage:'unknown',reason:'NATIVE_STARTUP_UNCLASSIFIED'});
 expect(caught.message).not.toContain('gateway-start');expect(caught.message).not.toContain(secret);expect(child.exitCode).toBe(1);expect(child.sent.some(message=>message.kind==='stop')).toBe(true);
 expect(()=>assertOwnedClosedNativeAuthority({} as any,pins,signal)).toThrow('OWNED_NATIVE_AUTHORITY_REQUIRED');expect(f.ports.authorizePhysical).not.toHaveBeenCalled();
});
it.each([25,120000])('keeps the startup timeout bounded and reports only the last valid owned stage (%d ms remaining)',async remaining=>{
 vi.useFakeTimers();
 try{
  const f=fixture();
  f.binding.hardStopUnixMs=Date.now()+remaining;
  const pins={window:f.binding.window,workId:f.binding.workId,caseId:f.binding.caseId,caseSessionId:f.binding.caseSessionId,toolChannelSha256:f.binding.toolChannelSha256,processIdentity:f.binding.processIdentity,
   clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(f.binding.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)};
  const child=new FailedChild(null),nonce='a'.repeat(64);
  child.send=function(message:any){
   this.sent.push(message);
   if(message.kind==='start'){
    this.emit('message',{kind:'startup_stage',nonce,stage:'gateway-start'});
    this.emit('message',{kind:'startup_stage',nonce:'f'.repeat(64),stage:'readiness'});
    this.emit('message',{kind:'startup_stage',nonce,stage:'gateway-settle',raw:secret});
    this.emit('message',{kind:'startup_stage',nonce,stage:secret});
   }
   return true;
  };
  const signal=new AbortController().signal;
  const launch=startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:hash('entry'),environment:{},bootstrap:f.options,pins,
   meterBinding:{nativeToken:'inert-token',deadlineUnixMs:f.binding.hardStopUnixMs},authorize:async()=>{},ports:f.ports,signal},
   {readBytes:async()=>Buffer.from('entry'),spawnChild:()=>child as any,nonce:()=>nonce});
  const result=launch.catch(error=>error);
  const limit=Math.min(90000,remaining);
  await vi.advanceTimersByTimeAsync(limit-1);
  expect(child.exitCode).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  const error=await result;
  expect(error).toMatchObject({code:'OWNED_NATIVE_BOOTSTRAP_TIMEOUT',startupElapsedMs:limit,
   nativeStartupDiagnostic:{version:1,stage:'gateway-start',reason:'OWNED_NATIVE_BOOTSTRAP_TIMEOUT'}});
  expect(error.message).not.toContain(secret);
  expect(child.exitCode).toBe(1);
  expect(f.ports.authorizePhysical).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});

let temporary='',childEntry='';
it.each(['missing','relative','foreign'] as const)('refuses %s native workspace before spawning or granting authority',async fault=>{
 const f=fixture(),spawnChild=vi.fn(),pins={window:f.binding.window,workId:f.binding.workId,caseId:f.binding.caseId,caseSessionId:f.binding.caseSessionId,toolChannelSha256:f.binding.toolChannelSha256,processIdentity:f.binding.processIdentity,clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(f.binding.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)};
 const paths={...f.paths,workspace:fault==='missing'?undefined:fault==='relative'?'relative/workspace':path.resolve('inert/foreign')} as any;
 await expect(startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:hash('entry'),environment:{},bootstrap:{...f.options,paths},pins,meterBinding:{nativeToken:'inert-token',deadlineUnixMs:f.binding.hardStopUnixMs},authorize:async()=>{},ports:f.ports,signal:new AbortController().signal},{readBytes:async()=>Buffer.from('entry'),spawnChild,nonce:()=> 'a'.repeat(64)})).rejects.toThrow('REVIEWED_NATIVE_WORKSPACE_REQUIRED');expect(spawnChild).not.toHaveBeenCalled();expect(f.ports.authorizePhysical).not.toHaveBeenCalled();
});
it('starts the real owned process in the reviewed private workspace rather than the operator cwd',async()=>{
 const workspace=path.join(temporary,'private workspace');await fs.mkdir(workspace);
 const entry=path.join(temporary,'inert-cwd-child.mjs'),code=`process.on('message',m=>{if(m.kind==='start')process.send({kind:'ready',nonce:m.nonce,observation:{...m.bootstrap.binding,kind:'actual_native_gateway_bootstrap_observation',runtimeObservation:'pending_first_harness',observedCwd:process.cwd()}});else if(m.kind==='stop')process.send({kind:'closed',nonce:m.nonce},()=>process.exit(0));});`;
 await fs.writeFile(entry,code,{flag:'wx'});const f=fixture();f.paths.workspace=workspace;f.binding.workspaceSha256=hash(path.resolve(workspace));
 const pins={window:f.binding.window,workId:f.binding.workId,caseId:f.binding.caseId,caseSessionId:f.binding.caseSessionId,toolChannelSha256:f.binding.toolChannelSha256,processIdentity:f.binding.processIdentity,clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(f.binding.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)};
 const handle=await startOwnedClosedNativeProcess({nodeExecutable:process.execPath,childEntry:entry,childEntrySha256:hash(code),environment:{},bootstrap:f.options,pins,meterBinding:{nativeToken:'inert-token',deadlineUnixMs:f.binding.hardStopUnixMs},authorize:async()=>{},ports:f.ports,signal:new AbortController().signal});
 try{expect(handle.readiness()).toMatchObject({observedCwd:workspace});expect(workspace).not.toBe(process.cwd());expect(f.ports.authorizePhysical).not.toHaveBeenCalled();}finally{await handle.close();}
});
beforeAll(async()=>{
 temporary=await fs.mkdtemp(path.join(os.tmpdir(),'envoi-startup-diagnostic-'));
 const result=await build({configFile:false,envDir:false,logLevel:'silent',build:{write:false,minify:false,target:'node24',lib:{entry:fileURLToPath(new URL('./closed-native-child.ts',import.meta.url)),formats:['es'],fileName:()=> 'child.mjs'},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}});
 const outputs=(Array.isArray(result)?result:[result]).flatMap(output=>'output' in output?output.output:[]);
 const chunk=outputs.find(item=>item.type==='chunk');if(!chunk||chunk.type!=='chunk')throw Error('INERT_CHILD_BUILD_REQUIRED');
 childEntry=path.join(temporary,'child.mjs');await fs.writeFile(childEntry,chunk.code,{flag:'wx'});
},30000);
afterAll(async()=>{if(temporary&&path.dirname(path.resolve(temporary))===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith('envoi-startup-diagnostic-'))await fs.rm(temporary,{recursive:true,force:true});});
it.each(['environment','private-paths'] as const)('executes the built real child IPC handler for %s refusal without native imports, models or secrets',async stage=>{
 const f=fixture(),nonce='a'.repeat(64),environment={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,
  OPENCLAW_STATE_DIR:f.paths.stateDirectory,OPENCLAW_CONFIG_PATH:f.paths.configurationPath,...stage==='environment'?{HTTP_PROXY:secret}:{}};
 const child=spawn(process.execPath,[childEntry],{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';
 child.stdout!.on('data',data=>{stdout+=data;});child.stderr!.on('data',data=>{stderr+=data;});
 const exited=once(child,'exit');
 try{
  const observed:any[]=[];
  const message=new Promise<any>(resolve=>child.on('message',(value:any)=>{
   observed.push(value);
   if(value.kind==='failed')resolve(value);
  }));
  child.send({kind:'start',nonce,bootstrap:{...f.options,paths:{...f.paths,stateDirectory:path.resolve(secret)}}});
  const failure=await message;
  expect(failure).toEqual({kind:'failed',nonce,diagnostic:{version:1,stage,reason:stage==='environment'?'ACTUAL_RESTRICTED_NATIVE_ENVIRONMENT_REQUIRED':'REVIEWED_NATIVE_PRIVATE_PATH_REQUIRED'}});
  expect(observed.slice(0,-1)).toEqual(stage==='environment'?[]:[
   {kind:'startup_stage',nonce,stage:'authorization'},{kind:'startup_stage',nonce,stage:'private-paths'},
  ]);
  expect(JSON.stringify(observed)).not.toContain(secret);expect(stdout+stderr).not.toContain(secret);
 }finally{child.kill();await exited;}
},15000);
