// Read-only recovery evidence for a receiver failure before any native target.
// The old state, selected snapshot, events and contexts remain immutable.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ProgressPin} from './stopped-progress';
import type {ControlledProgressRecovery} from './controlled-progress';
import type {ControlledStartupStop} from './controlled-startup';

export type ControlledPreTargetPins=Readonly<{
 state:ProgressPin;events:ProgressPin;ownerGatewayContext:ProgressPin;selection:ProgressPin;nativeSendContext:ProgressPin;
}>;
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const keys=(v:any)=>object(v)?Object.keys(v).sort().join():undefined;
function refuse(code:string):never{throw Object.assign(Error(code),{code});}
async function read(pin:ProgressPin,parse=true){
 if(!pin||!path.isAbsolute(pin.path)||!/^[a-f0-9]{64}$/.test(pin.sha256))refuse('EXACT_PRETARGET_PIN_REQUIRED');
 const s=await fs.lstat(pin.path);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>2000000)refuse('BOUNDED_PRETARGET_PIN_REQUIRED');
 const raw=await fs.readFile(pin.path);if(hash(raw)!==pin.sha256)refuse('PRETARGET_EVIDENCE_CHANGED');
 return{raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};
}
function direct(pin:ProgressPin,dir:string,name?:string){if(path.dirname(path.resolve(pin.path))!==path.resolve(dir)||name!==undefined&&path.basename(pin.path)!==name)refuse('OWNED_PRETARGET_PATH_REQUIRED');}
async function empty(dir:string){try{const s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||(await fs.readdir(dir)).length)refuse('NO_NATIVE_TARGET_PREPARATION_REQUIRED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}

export async function inspectControlledPreTarget(input:{proof:ControlledStartupStop;packet:any;execution:any;checkpoint:any;recovery:ControlledProgressRecovery;controlWindow:string;now:number}){
 const{proof,packet:p,execution:e,checkpoint:c,recovery:r}=input,q=proof.preTarget!;
 if(keys(q)!=='events,nativeSendContext,ownerGatewayContext,selection,state'||!equal(c.preTargetPins,q)
   ||c.receiversStopped!==true||c.operatorWorkerStopped!==true||c.nativeGatewayListening!==false||c.nativeProxyListening!==false)refuse('EXACT_PRETARGET_CLEANUP_REQUIRED');
 const dir=proof.programDirectory;
 direct(q.state,dir);direct(q.selection,dir);direct(q.nativeSendContext,dir,'native-send-context.private.json');
 direct(q.events,p.directory,'actual-events.private.jsonl');direct(q.ownerGatewayContext,p.directory,'owner-gateway-context.private.json');
 const stat=await fs.lstat(dir),files=await fs.readdir(dir),expected=[q.state,q.selection,q.nativeSendContext].map(x=>path.basename(x.path)).sort();
 if(!stat.isDirectory()||stat.isSymbolicLink()||new Set(expected).size!==3||!equal(files.sort(),expected))refuse('EXACT_PRETARGET_PROGRAM_FILES_REQUIRED');
 await empty(path.join(p.directory,'owner-requests'));await empty(path.join(p.directory,'openclaw-evidence'));
 const state=(await read(q.state)).value,original=(await read(r.state)).value,selected=(await read(q.selection)).value,
  context=(await read(q.ownerGatewayContext)).value,send=(await read(q.nativeSendContext)).value;
 const work=original.started.openclaw,receipt=e.receipt,old=(await read(r.execution)).value.receipt;
 const stateKeys='carriedControlObservations,carriedOpenClawPollObservation,carriedProgress,carriedTaskReceipts,controlProofs,effects,phase,planSha256,results,started,taskReceipts,window';
 if(keys(state)!==stateKeys||state.phase!=='prepared'||state.window!==e.window||state.planSha256!==hash(JSON.stringify(canon({...p.program,windowId:e.window})))
   ||keys(state.started)!=='openclaw'||keys(state.results)!==''||keys(state.effects)!==''||!equal(state.controlProofs,original.controlProofs)
   ||state.started.openclaw.workId!==work.workId||state.started.openclaw.caseId!==work.caseId||state.started.openclaw.beforeSha256!==q.selection.sha256
   ||!equal(state.taskReceipts,original.taskReceipts)||!equal(state.carriedProgress,original.carriedProgress)
   ||!equal(state.carriedTaskReceipts,original.carriedTaskReceipts)||state.carriedTaskReceipts?.shared?.acceptedSendRepeated!==false
   ||state.carriedTaskReceipts.shared.receiptDigest!==hash(JSON.stringify(canon(original.taskReceipts.shared))))refuse('ZERO_NATIVE_PRETARGET_STATE_REQUIRED');
 const controls=state.carriedControlObservations?.openclaw,poll=state.carriedOpenClawPollObservation;
 if(keys(state.carriedControlObservations)!=='openclaw'||controls?.priorSource!==old.clientSource||controls.priorWindow!==input.controlWindow
   ||controls.controlsRepeated!==false||controls.newSourceControlCredit!==false||controls.descriptor?.path!==r.carry.path||controls.descriptor.sha256!==r.carry.sha256
   ||poll?.priorSource!==old.clientSource||poll.priorWindow!==input.controlWindow||poll.workId!==work.workId||poll.pollInterruptedAgain!==false||poll.newSourcePollCredit!==false
   ||poll.descriptor?.path!==r.carry.path||poll.descriptor.sha256!==r.carry.sha256)refuse('ORIGINAL_PRETARGET_CONTROL_PROVENANCE_REQUIRED');
 if(selected.case?.id!==work.caseId||!Array.isArray(selected.messages)||selected.messages.filter((m:any)=>m.id===work.workId&&m.caseId===work.caseId).length!==1)refuse('EXACT_PRETARGET_SELECTED_WORK_REQUIRED');
 if(context.window!==e.window||context.hardStopUtc!==receipt.hardStopUtc||context.librarySha256!==receipt.runnerSha256
   ||send.windowId!==e.window||send.startUtc!==receipt.startUtc||send.hardStopUtc!==receipt.hardStopUtc||send.clientSource!==receipt.clientSource||send.librarySha256!==receipt.runnerSha256)refuse('ORIGINAL_PRETARGET_CONTEXT_REQUIRED');
 const raw=(await read(q.events,false)).raw;if(!raw.toString().endsWith('\n'))refuse('COMPLETE_PRETARGET_EVENTS_REQUIRED');
 const events=raw.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
 const allowed=['actual_hermes_gateway_ready','actual_session_started_awaiting_personal_gateway_addresses','existing_receiver_ready','owned_native_factory_ready',
  'prior_openclaw_controls_carried_without_repetition','prior_openclaw_poll_gap_carried_without_repetition','actual_canonical_context','actual_bounded_case_snapshot','receiver_startup_transport_failure','canonical_settlement'];
 if(events.length>16||events.some(v=>!allowed.includes(v.kind)||v.window!==e.window||!Number.isFinite(Date.parse(v.atUtc))||Date.parse(v.atUtc)<Date.parse(e.actualStartedAtUtc)||Date.parse(v.atUtc)>Date.parse(c.stopState.observedAtUtc)))refuse('ZERO_NATIVE_PRETARGET_EVENTS_REQUIRED');
 const one=(kind:string)=>{const found=events.filter(v=>v.kind===kind);if(found.length!==1)refuse('EXACT_PRETARGET_EVENT_SEQUENCE_REQUIRED');return found[0];};
 const gateways=events.filter(v=>v.kind==='actual_hermes_gateway_ready'),receivers=events.filter(v=>v.kind==='existing_receiver_ready');
 if(gateways.length!==2||!['je1','testowner'].every(role=>gateways.filter(v=>v.role===role&&v.modelRequestsAdded===0).length===1)
   ||receivers.length!==3||!['je1','testowner','openclaw'].every(role=>receivers.filter(v=>v.role===role&&v.receivingStarted===true&&v.newEnrollment===false).length===1))refuse('EXACT_PRETARGET_RECEIVER_HISTORY_REQUIRED');
 const session=one('actual_session_started_awaiting_personal_gateway_addresses'),factory=one('owned_native_factory_ready');
 if(session.modelCalls!==c.usage.chargedAttempts||session.onboardingRepeated!==false||session.acceptedSendsRepeated!==false||factory.nativeGatewayStarted!==false||factory.modelPromptsSubmitted!==0)refuse('ZERO_NATIVE_PRETARGET_EVENTS_REQUIRED');
 for(const[kind,flag]of [['prior_openclaw_controls_carried_without_repetition','newControlRun'],['prior_openclaw_poll_gap_carried_without_repetition','newPollInterruption']]){
  const v=one(kind);if(v.priorSource!==old.clientSource||v.priorWindow!==input.controlWindow||v.workId!==work.workId||v.descriptorSha256!==r.carry.sha256||v[flag]!==false)refuse('ORIGINAL_PRETARGET_CONTROL_PROVENANCE_REQUIRED');
 }
 const canonical=one('actual_canonical_context'),snapshot=one('actual_bounded_case_snapshot'),settled=one('canonical_settlement');
 if(canonical.flowId!=='openclaw'||canonical.role!=='openclaw'||canonical.workId!==work.workId||canonical.caseId!==work.caseId
   ||!canonical.session?.id||!Number.isSafeInteger(canonical.session.fence)||canonical.session.fence<1
   ||canonical.session.agentId!==p.actors.openclaw.agentId||canonical.session.installationId!==p.actors.openclaw.installationId
   ||snapshot.flowId!=='openclaw'||snapshot.workId!==work.workId||snapshot.caseId!==work.caseId||typeof snapshot.rawSnapshotBytes!=='string'||hash(snapshot.rawSnapshotBytes)!==snapshot.sha256
   ||settled.role!=='openclaw'||settled.workId!==work.workId||settled.status!=='retryable'||settled.operation!=='fail'
   ||events.indexOf(canonical)>=events.indexOf(snapshot)||events.indexOf(snapshot)>=events.indexOf(settled)
   ||events.filter(v=>v.kind==='receiver_startup_transport_failure').length>1)refuse('ACTUAL_PRETARGET_RETRYABLE_SETTLEMENT_REQUIRED');
}
