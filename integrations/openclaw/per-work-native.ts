import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
import {prepareNativeObserverPatch} from './native-observer-patch';import {CLOSED_NATIVE_BOOTSTRAP_FILES,CLOSED_NATIVE_POLICY_FILES} from './closed-native-bootstrap';
import {startOwnedClosedNativeProcess,closedNativeManifestDigest,type OwnedClosedNativeOptions} from './owned-native-process';
import {openClawTargetDigest,type OpenClawWorkTarget} from './scoped-target';import type {ClosedNativeBinding} from './closed-native-owner';
import {nativeCodeTreeDigest} from './native-code-tree';
import {createServer} from 'node:net';
import {bindOpenClawPreclaim,deriveOpenClawPreclaimCapability,openClawPreclaimReceiptSha256,type OpenClawPreclaimTarget,type ApprovedOpenClawPreclaim} from './preclaim-selection';
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
declare const factoryBrand:unique symbol;export type OwnedOpenClawFactory=Readonly<{[factoryBrand]:true}>;
export interface OwnedOpenClawFactoryPins{clientSource:string;nativeSourceSha256:string;factoryPolicySha256:string;}
export interface NativeFactoryPreparation{sourceNativeRoot:string;destinationNativeRoot:string;workRoot:string;originalProfile:string;nodeExecutable:string;nativeEnvironmentFile?:string;
 childEntry:string;childEntrySha256:string;clientSource:string;factoryPolicySha256:string;authorize():Promise<void>;}
type Factory={options:NativeFactoryPreparation;pins:Readonly<OwnedOpenClawFactoryPins>;sources:Record<string,string>;prepared:Set<string>};
const factories=new WeakMap<object,Factory>();
const inside=(root:string,target:string)=>{const r=path.resolve(root),p=path.resolve(target);if(p===r||!p.startsWith(r+path.sep))throw Error('NEW_PRIVATE_NATIVE_PATH_REQUIRED');return p;};
async function canonicalPath(value:string){let current=path.resolve(value),tail:string[]=[];while(true){try{const resolved=path.join(await fs.realpath(current),...tail);return process.platform==='win32'?resolved.toLowerCase():resolved;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)throw e;tail.unshift(path.basename(current));current=parent;}}}
async function disjoint(a:string,b:string){const[x,y]=await Promise.all([canonicalPath(a),canonicalPath(b)]);if(x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep))throw Error('DISJOINT_NATIVE_COPY_PATHS_REQUIRED');}
async function fileHash(file:string){return hash(await fs.readFile(file));}
async function sourceHashes(root:string){return{...Object.fromEntries(await Promise.all(Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).map(async([k,p])=>[k,await fileHash(path.join(root,p))]))),packageTree:await nativeCodeTreeDigest(root)};}
/** Copy code only. Original installed package/profile/enrollment are never written. */
export async function prepareOwnedOpenClawFactory(options:NativeFactoryPreparation){
 await options.authorize();if(!path.isAbsolute(options.sourceNativeRoot)||!path.isAbsolute(options.destinationNativeRoot)||options.sourceNativeRoot===options.destinationNativeRoot)throw Error('SEPARATE_NATIVE_PACKAGE_COPY_REQUIRED');
 if(!path.isAbsolute(options.workRoot)||!path.isAbsolute(options.originalProfile)||path.resolve(options.workRoot).startsWith(path.resolve(options.originalProfile)+path.sep)||path.resolve(options.workRoot)===path.resolve(options.originalProfile))throw Error('SEPARATE_NATIVE_PROFILE_COPIES_REQUIRED');
 await disjoint(options.sourceNativeRoot,options.destinationNativeRoot);await disjoint(options.sourceNativeRoot,options.workRoot);await disjoint(options.workRoot,options.originalProfile);await disjoint(options.destinationNativeRoot,options.originalProfile);await disjoint(options.destinationNativeRoot,options.workRoot);
 if(!/^[a-f0-9]{40}$/.test(options.clientSource)||!/^[a-f0-9]{64}$/.test(options.factoryPolicySha256)||await fileHash(options.childEntry)!==options.childEntrySha256)throw Error('REVIEWED_NATIVE_FACTORY_SOURCE_REQUIRED');
 for(const p of['package.json','node_modules/@openclaw/ai/package.json'])if(JSON.parse(await fs.readFile(path.join(options.sourceNativeRoot,p),'utf8')).version!=='2026.10.5')throw Error('PINNED_NATIVE_PACKAGE_VERSION_REQUIRED');
 const manifest=path.join(options.destinationNativeRoot,'envoi-native-source-copy.json');
 try{await fs.access(manifest);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  const source={'model-registry-Bc1CKDx-.mjs':await fs.readFile(path.join(options.sourceNativeRoot,'dist/model-registry-Bc1CKDx-.mjs'),'utf8'),'selection-BCmRjyeC.mjs':await fs.readFile(path.join(options.sourceNativeRoot,'dist/selection-BCmRjyeC.mjs'),'utf8')};
  const patched=prepareNativeObserverPatch(source);await fs.mkdir(path.dirname(options.destinationNativeRoot),{recursive:true});
  try{await fs.lstat(options.destinationNativeRoot);throw Error('INCOMPLETE_NATIVE_SOURCE_COPY_REVIEW_REQUIRED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await fs.cp(options.sourceNativeRoot,options.destinationNativeRoot,{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true,dereference:true});
  for(const[name,bytes]of Object.entries(patched))await fs.writeFile(path.join(options.destinationNativeRoot,'dist',name),bytes,{mode:0o600});
  await fs.writeFile(manifest,JSON.stringify({nativeVersion:'2026.10.5',sources:await sourceHashes(options.destinationNativeRoot)}),{flag:'wx',mode:0o600});
 }
 const saved=JSON.parse(await fs.readFile(manifest,'utf8')),sources=await sourceHashes(options.destinationNativeRoot);
 // The prior preparation manifest pinned the same complete tree plus nine bootstrap
 // files. Preserve it byte-for-byte: a fresh detached full-tree audit may add the
 // reviewed selector pins in RAM without changing any sealed native-copy bytes.
 const keys=Object.keys(saved.sources??{}).sort(),currentKeys=Object.keys(sources).sort(),legacyKeys=[...Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES).filter(k=>!Object.hasOwn(CLOSED_NATIVE_POLICY_FILES,k)),'packageTree'].sort();
 if(saved.nativeVersion!=='2026.10.5'||![currentKeys,legacyKeys].some(expected=>JSON.stringify(expected)===JSON.stringify(keys))||Object.entries(saved.sources).some(([k,v])=>sources[k]!==v))throw Error('PREPARED_NATIVE_SOURCE_COPY_DRIFT');
 const pins=Object.freeze({clientSource:options.clientSource,nativeSourceSha256:closedNativeManifestDigest(sources),factoryPolicySha256:options.factoryPolicySha256}),factory=Object.freeze({})as OwnedOpenClawFactory;
 await fs.mkdir(options.workRoot,{recursive:true,mode:0o700});factories.set(factory,{options:Object.freeze({...options}),pins,sources,prepared:new Set()});return{factory,pins};
}
async function checkFactory(factory:OwnedOpenClawFactory,expected:Readonly<OwnedOpenClawFactoryPins>,signal:AbortSignal,fullTree:boolean){signal.throwIfAborted();const state=factories.get(factory);if(!state)throw Error('PREPARED_OWNED_NATIVE_FACTORY_REQUIRED');
 if(Object.keys(expected).length!==3||Object.entries(state.pins).some(([k,v])=>expected[k as keyof OwnedOpenClawFactoryPins]!==v))throw Error('OWNED_NATIVE_FACTORY_BINDING_MISMATCH');
 await state.options.authorize();signal.throwIfAborted();if(await fileHash(state.options.childEntry)!==state.options.childEntrySha256)throw Error('OWNED_NATIVE_FACTORY_SOURCE_DRIFT');
 const critical=Object.fromEntries(await Promise.all(Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).map(async([k,p])=>[k,await fileHash(path.join(state.options.destinationNativeRoot,p))])));if(Object.entries(critical).some(([k,v])=>state.sources[k]!==v)||fullTree&&await nativeCodeTreeDigest(state.options.destinationNativeRoot)!==state.sources.packageTree)throw Error('OWNED_NATIVE_FACTORY_SOURCE_DRIFT');
 return Object.freeze({...state.pins,kind:'actual_prepared_native_factory',nativeGatewayStarted:false,modelPromptsSubmitted:0});
}
// Factory branding is minted only after the detached complete-tree audit above.
// Receiver startup rechecks the26 critical seams without repeating that slow audit.
export async function assertOwnedOpenClawFactory(factory:OwnedOpenClawFactory,expected:Readonly<OwnedOpenClawFactoryPins>,signal:AbortSignal){return checkFactory(factory,expected,signal,false);}
export interface PrepareNativeWork{binding:ClosedNativeBinding;canonical:{recipientAgentId:string;installationId:string;fence:number};gatewayPort:number;proxyToken:string;proxyIdentity:string;signal:AbortSignal;}
type Prepared={factory:OwnedOpenClawFactory;binding:ClosedNativeBinding;paths:{stateDirectory:string;configurationPath:string;workspace:string;agentState:string};target:OpenClawWorkTarget;releasePort?:()=>Promise<void>;preclaimCapabilitySha256?:string;reservationSignal?:AbortSignal;};
declare const workBrand:unique symbol;export type PreparedOwnedOpenClawWork=Readonly<{[workBrand]:true}>;const works=new WeakMap<object,Prepared>();
/** Author canonical 2026.10.5 config with explicit model selection, independent of native cache metadata defaults. */
export function perWorkNativeAgents(b:Pick<ClosedNativeBinding,'nativeAgentId'|'modelId'>,paths:{workspace:string;agentState:string}){
 return{defaults:{workspace:paths.workspace,model:{primary:'anthropic/'+b.modelId,fallbacks:[]},modelPolicy:{allow:['anthropic/'+b.modelId]},models:{['anthropic/'+b.modelId]:{agentRuntime:{id:'openclaw'}}}},entries:{[b.nativeAgentId]:{workspace:paths.workspace,agentDir:paths.agentState}}};
}
/** Copies private native configuration locally; never copies an Envoi credential/journal store. */
export async function prepareOwnedOpenClawWork(factory:OwnedOpenClawFactory,input:PrepareNativeWork){const state=factories.get(factory);if(!state)throw Error('PREPARED_OWNED_NATIVE_FACTORY_REQUIRED');await checkFactory(factory,state.pins,input.signal,false);
 const b=input.binding;if(!/^msg_[A-Za-z0-9_-]+$/.test(b.workId)||!/^agent_[A-Za-z0-9_-]+$/.test(input.canonical.recipientAgentId)||!/^installation_[A-Za-z0-9_-]+$/.test(input.canonical.installationId)||!Number.isSafeInteger(input.canonical.fence)||input.canonical.fence<1||state.prepared.has(b.workId)||!Number.isInteger(input.gatewayPort)||input.gatewayPort<1||input.gatewayPort>65535)throw Error('NEW_EXACT_NATIVE_WORK_REQUIRED');state.prepared.add(b.workId);
 const {paths,token}=await prepareWorkConfiguration(state,b,input);
 const selected={...b,nativeSources:state.sources,stateDirectorySha256:hash(path.resolve(paths.stateDirectory)),configurationPathSha256:hash(path.resolve(paths.configurationPath)),workspaceSha256:hash(path.resolve(paths.workspace)),agentStateSha256:hash(path.resolve(paths.agentState))};
 const target:OpenClawWorkTarget={binding:{window:b.window,workId:b.workId,caseId:b.caseId,caseSessionId:b.caseSessionId,...input.canonical},gatewayUrl:'http://127.0.0.1:'+input.gatewayPort,gatewayToken:token,agentId:b.nativeAgentId,processIdentity:b.processIdentity,configurationSha256:await fileHash(paths.configurationPath),stateDirectorySha256:selected.stateDirectorySha256,configurationPathSha256:selected.configurationPathSha256,workspaceSha256:selected.workspaceSha256,agentStateSha256:selected.agentStateSha256,proxyOrigin:b.proxyOrigin,proxyIdentity:input.proxyIdentity,deadlineUnixMs:b.hardStopUnixMs,toolChannelSha256:b.toolChannelSha256,ownerSelectionSha256:''};
 const prepared=Object.freeze({})as PreparedOwnedOpenClawWork;works.set(prepared,{factory,binding:selected,paths,target});return{prepared,privateTarget:target};
}
async function prepareWorkConfiguration(state:Factory,b:Pick<ClosedNativeBinding,'workId'|'modelId'|'nativeAgentId'|'proxyOrigin'>,input:{gatewayPort:number;proxyToken:string}){
 const root=inside(state.options.workRoot,path.join(state.options.workRoot,b.workId)),paths={stateDirectory:path.join(root,'state'),configurationPath:path.join(root,'openclaw.json'),workspace:path.join(root,'workspace'),agentState:path.join(root,'agent-state')};
 await fs.mkdir(root,{recursive:false,mode:0o700});for(const d of[paths.stateDirectory,paths.workspace,paths.agentState])await fs.mkdir(d,{mode:0o700});
 const backup=path.join(root,'original-config.private.backup.json');await fs.copyFile(path.join(state.options.originalProfile,'openclaw.json'),backup,constants.COPYFILE_EXCL);
 const config=JSON.parse(await fs.readFile(backup,'utf8')),provider=config.models?.providers?.anthropic;if(!provider)throw Error('ORIGINAL_NATIVE_ANTHROPIC_PROFILE_REQUIRED');
 const nativeModel=provider.models?.find((m:any)=>m.id===b.modelId);if(!nativeModel)throw Error('ORIGINAL_NATIVE_MODEL_REQUIRED');
 const token=randomBytes(32).toString('hex');config.plugins={enabled:false,allow:[],deny:[],entries:{},load:{paths:[]},slots:{memory:'none',contextEngine:'none'}};
 config.models={mode:'replace',providers:{anthropic:{...provider,api:'anthropic-messages',baseUrl:b.proxyOrigin,agentRuntime:{id:'openclaw'},headers:{...provider.headers,'x-phase-c-meter':input.proxyToken},models:[{...nativeModel,agentRuntime:{id:'openclaw'}}]}}};
 config.agents=perWorkNativeAgents(b,paths);
 config.tools={profile:'minimal',deny:['*']};config.hooks={enabled:false};config.cron={enabled:false};delete config.cloudWorkers;
 config.gateway={...config.gateway,mode:'local',bind:'loopback',port:input.gatewayPort,auth:{...config.gateway?.auth,mode:'token',token},reload:{mode:'off'},http:{...config.gateway?.http,endpoints:{...config.gateway?.http?.endpoints,responses:{...config.gateway?.http?.endpoints?.responses,enabled:true}}}};
 await fs.writeFile(paths.configurationPath,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
 return{paths,token};
}
type ReservedBinding=Pick<ClosedNativeBinding,'window'|'workId'|'caseId'|'processIdentity'|'nativeAgentId'|'modelId'|'proxyOrigin'>;
declare const reservationBrand:unique symbol;
export type ReservedOwnedOpenClawWork=Readonly<{[reservationBrand]:true}>;
const reservations=new WeakMap<ReservedOwnedOpenClawWork,{factory:OwnedOpenClawFactory;binding:ReservedBinding;target:OpenClawPreclaimTarget;paths:Prepared['paths'];used:boolean;releasePort:()=>Promise<void>;signal:AbortSignal}>();
async function reserveGateway(port:number,signal:AbortSignal){
 signal.throwIfAborted();const server=createServer(socket=>socket.destroy());
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},()=>{server.removeListener('error',reject);resolve();});});
 let closing:Promise<void>|undefined;
 const close=()=>closing??=new Promise<void>((resolve,reject)=>{signal.removeEventListener('abort',abort);server.close(e=>e?reject(e):resolve());});
 const abort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted){await close();signal.throwIfAborted();}return close;
}
/** All human-visible paths/config/addresses are fixed without inventing a session or starting a lease. */
export async function reserveOwnedOpenClawWork(factory:OwnedOpenClawFactory,input:{binding:ReservedBinding;canonical:{recipientAgentId:string;installationId:string;inboxId:string};gatewayPort:number;proxyToken:string;proxyIdentity:string;signal:AbortSignal}){
 const state=factories.get(factory);if(!state)throw Error('PREPARED_OWNED_NATIVE_FACTORY_REQUIRED');await checkFactory(factory,state.pins,input.signal,false);
 const b=Object.freeze({...input.binding});if(!/^msg_[\w-]+$/.test(b.workId)||state.prepared.has(b.workId)||!Number.isInteger(input.gatewayPort)||input.gatewayPort<1||input.gatewayPort>65535)throw Error('NEW_EXACT_NATIVE_WORK_REQUIRED');state.prepared.add(b.workId);
 const cancel=new AbortController(),signal=AbortSignal.any([input.signal,cancel.signal]),releasePort=await reserveGateway(input.gatewayPort,signal);
 try{const{paths,token}=await prepareWorkConfiguration(state,b,input);input.signal.throwIfAborted();
 const target:OpenClawPreclaimTarget=Object.freeze({binding:Object.freeze({window:b.window,workId:b.workId,caseId:b.caseId,recipientAgentId:input.canonical.recipientAgentId,installationId:input.canonical.installationId}),...state.pins,inboxId:input.canonical.inboxId,modelId:b.modelId,
  gatewayUrl:'http://127.0.0.1:'+input.gatewayPort,gatewayToken:token,agentId:b.nativeAgentId,processIdentity:b.processIdentity,configurationSha256:await fileHash(paths.configurationPath),
  stateDirectorySha256:hash(path.resolve(paths.stateDirectory)),configurationPathSha256:hash(path.resolve(paths.configurationPath)),workspaceSha256:hash(path.resolve(paths.workspace)),agentStateSha256:hash(path.resolve(paths.agentState)),proxyOrigin:b.proxyOrigin,proxyIdentity:input.proxyIdentity});
 const reservation=Object.freeze({})as ReservedOwnedOpenClawWork;reservations.set(reservation,{factory,binding:b,target,paths,used:false,releasePort,signal});return{reservation,privateTarget:target,close:async()=>{cancel.abort(new Error('PRECLAIM_RESERVATION_CLOSED'));await releasePort();}};
 }catch(error){await releasePort();throw error;}
}
/** After review and a fresh claim, bind exactly one real session. No profile/config change is permitted. */
export async function bindReservedOpenClawWork(factory:OwnedOpenClawFactory,reservation:ReservedOwnedOpenClawWork,input:{approval:ApprovedOpenClawPreclaim;canonical:{recipientAgentId:string;installationId:string;fence:number};caseSessionId:string;toolChannelSha256:string;deadlineUnixMs:number;signal:AbortSignal}){
 const r=reservations.get(reservation),state=factories.get(factory);if(!r||r.factory!==factory||r.used||!state)throw Error('EXACT_NATIVE_RESERVATION_REQUIRED');
 r.signal.throwIfAborted();
 await checkFactory(factory,state.pins,input.signal,false);input.signal.throwIfAborted();
 if(await fileHash(r.paths.configurationPath)!==r.target.configurationSha256||input.canonical.recipientAgentId!==r.target.binding.recipientAgentId||input.canonical.installationId!==r.target.binding.installationId)throw Error('PRECLAIM_NATIVE_CONFIGURATION_CHANGED');
 const{clientSource:_,nativeSourceSha256:__,inboxId:___,factoryPolicySha256:____,modelId:_____,...stable}=r.target;
 const target:OpenClawWorkTarget={...stable,binding:{...r.target.binding,...input.canonical,caseSessionId:input.caseSessionId},toolChannelSha256:input.toolChannelSha256,deadlineUnixMs:input.deadlineUnixMs,ownerSelectionSha256:openClawPreclaimReceiptSha256(input.approval)};
 const selection=bindOpenClawPreclaim(input.approval,target),capability=deriveOpenClawPreclaimCapability(input.approval);r.used=true;
 const marker=await fs.open(path.join(path.dirname(r.paths.configurationPath),'preclaim-consent.used.json'),'wx',0o600);
 try{await marker.writeFile(JSON.stringify({purpose:'phase-c-one-claim-personal-selection',...selection}));await marker.sync();}finally{await marker.close();}
 const binding:ClosedNativeBinding={...r.binding,nativeSources:state.sources,caseSessionId:input.caseSessionId,toolChannelSha256:input.toolChannelSha256,hardStopUnixMs:input.deadlineUnixMs,stateDirectorySha256:target.stateDirectorySha256,configurationPathSha256:target.configurationPathSha256,workspaceSha256:target.workspaceSha256,agentStateSha256:target.agentStateSha256};
 const prepared=Object.freeze({})as PreparedOwnedOpenClawWork;works.set(prepared,{factory,binding,paths:r.paths,target,releasePort:r.releasePort,preclaimCapabilitySha256:capability.capabilitySha256,reservationSignal:r.signal});return{prepared,privateTarget:target,selection,capability};
}
/** Exact canonical scope and per-work personal receipts are required AFTER private preparation. */
export async function startOwnedOpenClawWork(factory:OwnedOpenClawFactory,prepared:PreparedOwnedOpenClawWork,options:{canonical:{recipientAgentId:string;installationId:string;fence:number};capabilitySha256:string;ownerSelectionSha256:string;meterToken:string;environment:NodeJS.ProcessEnv;signal:AbortSignal;authorize(target:OpenClawWorkTarget):Promise<void>;ports:OwnedClosedNativeOptions['ports']}){
 const state=factories.get(factory),work=works.get(prepared);if(!state||!work||work.factory!==factory)throw Error('EXACT_PREPARED_NATIVE_WORK_REQUIRED');
 // Consume synchronously before the first await, including concurrent callers.
 works.delete(prepared);await checkFactory(factory,state.pins,options.signal,false);
 work.reservationSignal?.throwIfAborted();if(await fileHash(work.paths.configurationPath)!==work.target.configurationSha256)throw Error('PREPARED_NATIVE_CONFIGURATION_CHANGED');
 if(Object.entries(options.canonical).some(([k,v])=>work.target.binding[k as keyof typeof options.canonical]!==v))throw Error('PREPARED_NATIVE_CANONICAL_SCOPE_CHANGED');
 if(work.preclaimCapabilitySha256&&(options.capabilitySha256!==work.preclaimCapabilitySha256||options.ownerSelectionSha256!==work.target.ownerSelectionSha256))throw Error('EXACT_PRECLAIM_NATIVE_CAPABILITY_REQUIRED');
 const target=Object.freeze({...work.target,binding:Object.freeze({...work.target.binding,...options.canonical}),ownerSelectionSha256:options.ownerSelectionSha256});await options.authorize(target);
 // Release only the inert socket we own, immediately before this exact child
 // binds. A bind race fails startup; there is never an alternate-port fallback.
 await work.releasePort?.();options.signal.throwIfAborted();work.reservationSignal?.throwIfAborted();
 const handle=await startOwnedClosedNativeProcess({nodeExecutable:state.options.nodeExecutable,nativeEnvironmentFile:state.options.nativeEnvironmentFile,childEntry:state.options.childEntry,childEntrySha256:state.options.childEntrySha256,
  environment:{...options.environment,OPENCLAW_STATE_DIR:work.paths.stateDirectory,OPENCLAW_CONFIG_PATH:work.paths.configurationPath,OPENCLAW_CONFIG_READONLY:'1',OPENCLAW_GATEWAY_PORT:String(new URL(target.gatewayUrl).port)},
  bootstrap:{nativeRoot:state.options.destinationNativeRoot,binding:work.binding,paths:work.paths,port:Number(new URL(target.gatewayUrl).port),sourceSha256:state.sources as any},
  pins:{window:work.binding.window,workId:work.binding.workId,caseId:work.binding.caseId,caseSessionId:work.binding.caseSessionId,toolChannelSha256:work.binding.toolChannelSha256,processIdentity:work.binding.processIdentity,
   clientSource:state.pins.clientSource,nativeSourceSha256:state.pins.nativeSourceSha256,capabilitySha256:options.capabilitySha256,ownerSelectionSha256:options.ownerSelectionSha256,targetSha256:openClawTargetDigest(target)},
  meterBinding:{nativeToken:options.meterToken,deadlineUnixMs:work.binding.hardStopUnixMs},authorize:()=>options.authorize(target),ports:options.ports,signal:work.reservationSignal?AbortSignal.any([options.signal,work.reservationSignal]):options.signal});return{...handle,target};
}
