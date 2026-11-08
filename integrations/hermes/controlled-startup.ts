// Historical startup stops after control carry, before any receiver/native work.
// Inspection grants no replacement source, clock, marker, runtime or prompt.
import fs from'node:fs/promises';import path from'node:path';import{createHash}from'node:crypto';
import type{ProgressPin}from'./stopped-progress';import type{ControlledProgressRecovery}from'./controlled-progress';
import type{RequestBudgetLedger}from'./request-budget';import type{ContinuationReceipt}from'./continuation-controller';
export type ControlledStartupStop=Readonly<{packet:ProgressPin;execution:ProgressPin;stop:ProgressPin;checkpoint:ProgressPin;ledger:ProgressPin;adoption:ProgressPin;programDirectory:string}>;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex'),canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
function refuse(code:string):never{throw Object.assign(Error(code),{code});}
async function read(p:ProgressPin,parse=true){if(!p||!path.isAbsolute(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256))refuse('EXACT_STARTUP_STOP_PIN_REQUIRED');const s=await fs.lstat(p.path);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>2000000)refuse('BOUNDED_STARTUP_STOP_PIN_REQUIRED');const raw=await fs.readFile(p.path);if(hash(raw)!==p.sha256)refuse('STARTUP_STOP_EVIDENCE_CHANGED');return{raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};}
async function marker(file:string){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>16384)refuse('REGULAR_STARTUP_ADMISSION_MARKER_REQUIRED');return JSON.parse(await fs.readFile(file,'utf8'));}
const samePin=(a:any,b:ProgressPin)=>a&&typeof a.path==='string'&&path.resolve(a.path)===path.resolve(b.path)&&a.sha256===b.sha256;
export async function readControlledStartupFrames(proofs:readonly ControlledStartupStop[]|undefined){
 if(proofs!==undefined&&(!Array.isArray(proofs)||!proofs.length||proofs.length>4))refuse('BOUNDED_CONTROLLED_STARTUP_HISTORY_REQUIRED');
 const frames=[];for(const proof of proofs??[])frames.push({proof,execution:(await read(proof.execution)).value});return frames;
}
export async function inspectControlledStartupFrames(input:{releaseRoot:string;recovery:ControlledProgressRecovery;frames:Awaited<ReturnType<typeof readControlledStartupFrames>>;ledger:RequestBudgetLedger;rows:Buffer;frozen:Buffer;controlWindow:string;journals:any[];states:any}){
 const{recovery:r,frames,ledger,rows,frozen}=input;if(!frames.length)return;
 const now=Date.now(),allRows=rows.toString().trimEnd().split('\n').map(line=>JSON.parse(line)),baseCount=frozen.toString().trimEnd().split('\n').length;
 let previousWindow=input.controlWindow,previousExecution=r.execution;
 for(let i=0;i<frames.length;i++){
  const{proof,execution:e}=frames[i],p=(await read(proof.packet)).value,stop=(await read(proof.stop)).value,c=(await read(proof.checkpoint)).value,adoption=(await read(proof.adoption)).value,receipt=e.receipt as ContinuationReceipt;
  if(e.purpose!=='actual-controlled-checkpoint-recovery'||e.window!==hash(JSON.stringify(receipt))||!samePin(e.priorExecution,previousExecution)||!samePin(e.carriedState,r.state)||!samePin(e.carriedCheckpoint,r.carry)
    ||!Number.isFinite(Date.parse(e.actualStartedAtUtc))||Date.parse(e.actualStartedAtUtc)<Date.parse(receipt.startUtc)||Date.parse(e.actualStartedAtUtc)>now
    ||p.purpose!=='phase-c-prepared-controlled-progress-session'||p.clientSource!==receipt.clientSource||p.serverSource!==receipt.serverSource||p.library?.sha256!==receipt.runnerSha256
    ||proof.packet.sha256!==receipt.packetSha256||path.resolve(p.oldKitRoot??'')!==path.resolve(input.releaseRoot)||p.carriedStateSha256!==r.state.sha256)refuse('ACTUAL_CONTROLLED_STARTUP_EXECUTION_REQUIRED');
  const base=p.controlledRecoveryBase;
  for(const key of['runtimePacket','initialExecution','execution','operatorSeal','state','stop','ledger','checkpoint','carry','pollGap'] as const)if(!samePin(base?.[key],r[key]))refuse('EXACT_CONTROLLED_STARTUP_ANCESTRY_REQUIRED');
  if(!equal(base.startupStops??[],r.startupStops!.slice(0,i)))refuse('EXACT_CONTROLLED_STARTUP_ANCESTRY_REQUIRED');
  const prefix=Buffer.from(allRows.slice(0,baseCount+2*(i+1)).map(row=>JSON.stringify(row)+'\n').join(''));
  const frozenLedger=(await read(proof.ledger,false)).raw;
  if(!frozenLedger.equals(prefix)||i===frames.length-1&&!frozenLedger.equals(rows)||allRows[baseCount+2*i+1]?.proof?.graphApprovalRaw!==e.graphApprovalRaw)refuse('EXACT_ZERO_NATIVE_STARTUP_LEDGER_REQUIRED');
  const observed=Date.parse(stop.observedAtUtc),checked=Date.parse(c.checkedAtUtc);
  if(stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='owned-runtime-startup'||stop.packetSha256!==proof.packet.sha256||stop.gateComplete!==false
    ||!Number.isFinite(observed)||observed<Date.parse(receipt.startUtc)||observed>now
    ||!['actual-540-startup-stop-readonly','actual-controlled-startup-stop-readonly'].includes(c.purpose)||!Number.isFinite(checked)||checked<observed||checked>now
    ||!samePin(c.packet,proof.packet)||!samePin(c.execution,proof.execution)||!samePin(c.stop,proof.stop)||!samePin(c.ledger,proof.ledger)||!equal(c.stopState,stop)||!equal(c.executionReceipt,e)
    ||c.usage?.chargedAttempts!==ledger.snapshot().chargedAttempts||c.usage.pending!==0||c.usage.unresolvedDispatches!==0||c.modelCallsAdded!==0||c.hostStarts!==0
    ||c.ownedMeterListening!==false||c.ownerGatewayContextAbsent!==true||c.sharedNativeJournalAbsent!==true
    ||!Array.isArray(c.selectedHermesHosts)||c.selectedHermesHosts.length!==3||!['je1','je2','testowner'].every(role=>c.selectedHermesHosts.filter((x:any)=>x.role===role&&x.unreachable===true).length===1))refuse('ACTUAL_CONTROLLED_STARTUP_STOP_REQUIRED');
  if(!Array.isArray(c.originalJournals)||c.originalJournals.length!==input.journals.length||input.journals.some(j=>c.originalJournals.filter((x:any)=>x.role===j.role&&x.file===j.file&&x.unchanged===true).length!==1))refuse('EXACT_STARTUP_ORIGINAL_JOURNALS_REQUIRED');
  if(!path.isAbsolute(proof.programDirectory)||path.resolve(proof.programDirectory)!==path.resolve(p.directory??'','native-program'))refuse('NO_STARTED_NATIVE_PROGRAM_REQUIRED');
  try{const s=await fs.lstat(proof.programDirectory);if(!s.isDirectory()||s.isSymbolicLink()||(await fs.readdir(proof.programDirectory)).length)refuse('NO_STARTED_NATIVE_PROGRAM_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{await fs.lstat(path.join(p.directory,'owner-gateway-context.private.json'));refuse('NO_STARTED_NATIVE_PROGRAM_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const priorLedger=i?frames[i-1].proof.ledger:r.ledger,previousReceipt=i?frames[i-1].execution.receipt:(await read(r.execution)).value.receipt;
  if(proof.adoption.sha256!==receipt.approvalReceiptSha256||adoption.ownerApproved!==true||adoption.clientSource!==receipt.clientSource||adoption.serverSource!==receipt.serverSource
    ||adoption.packetSha256!==proof.packet.sha256||adoption.runnerSha256!==receipt.runnerSha256||adoption.priorWindow!==previousWindow||adoption.modelCap!==64
    ||adoption.operationCap!==60||adoption.caseCap!==9||adoption.installationCap!==5||adoption.assetCap!==6||adoption.currentModels!==ledger.snapshot().chargedAttempts
    ||adoption.priorExecutionSha256!==previousExecution.sha256||adoption.priorLedgerSha256!==priorLedger.sha256||adoption.priorStateSha256!==r.state.sha256||adoption.carrySha256!==r.carry.sha256
    ||adoption.repeatOnboarding!==false||adoption.replayAcceptedSends!==false||adoption.repeatObservedControls!==false
    ||typeof adoption.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(adoption.decisionId))refuse('ORIGINAL_STARTUP_AUTHORITY_REQUIRED');
  const received=Date.parse(adoption.receivedAtUtc),start=Date.parse(receipt.startUtc),end=Date.parse(receipt.hardStopUtc);
  if(!Number.isFinite(received)||received>Date.parse(e.actualStartedAtUtc)||!Number.isSafeInteger(adoption.maximumIntervalMs)||adoption.maximumIntervalMs<1||adoption.maximumIntervalMs>5400000
    ||(adoption.timeMode==='same-fixed'?(receipt.startUtc!==previousReceipt.startUtc||receipt.hardStopUtc!==previousReceipt.hardStopUtc):adoption.timeMode!=='new-interval'||received>start||start<Date.parse(previousReceipt.startUtc)||end-start>adoption.maximumIntervalMs))refuse('ORIGINAL_STARTUP_TIME_AUTHORITY_REQUIRED');
  const admission=await marker(path.join(input.releaseRoot,'phase-c-controlled-progress-'+previousWindow+'.used.json'));
  if(admission.purpose!=='phase-c-one-use-controlled-progress'||admission.priorWindow!==previousWindow||admission.nextWindow!==e.window||admission.stateSha256!==r.state.sha256||admission.ledgerSha256!==priorLedger.sha256)refuse('ORIGINAL_STARTUP_ADMISSION_MARKER_REQUIRED');
  const time=await marker(path.join(input.releaseRoot,'phase-c-recovery-time-'+hash('pjsk02\0'+adoption.decisionId)+'.used.json'));
  if(time.purpose!=='phase-c-one-use-controlled-progress-recovery'||time.decisionId!==adoption.decisionId||time.approvalSha256!==proof.adoption.sha256||time.priorWindow!==previousWindow||time.window!==e.window)refuse('ORIGINAL_STARTUP_TIME_MARKER_REQUIRED');
  previousWindow=e.window;previousExecution=proof.execution;
 }
 const last=frames.at(-1)!;return{proof:last.proof,receipt:last.execution.receipt as ContinuationReceipt,window:last.execution.window as string};
}
