// Recovery after actual controls, before the first native target/admission.
// Historical results are pinned, never recreated or promoted to native success.
import {readUnforwardedPin} from './controlled-unforwarded';
import {inspectAcceptedCheckpointHistory,type AcceptedCheckpointCarry} from './accepted-checkpoint-retry';
import {inspectAcceptedCheckpointSessions} from './accepted-checkpoint-retention';
import fs from'node:fs/promises';import path from'node:path';import{createHash}from'node:crypto';
import type{ContinuationReceipt,ActiveContinuationReceipt}from'./continuation-controller';
import{inspectStoppedProgress,inspectStoppedProgressHistory,type ProgressPin,type StoppedProgressRecovery,type StoppedProgressPreflight}from'./stopped-progress';
import type{RequestBudgetLedger}from'./request-budget';import{hashReviewedContinuationPlan}from'./continuation-plan';
import{readControlledStartupFrames,inspectControlledStartupFrames,type ControlledStartupStop}from'./controlled-startup';
export type ControlledProgressRecovery=Readonly<{
  history:StoppedProgressRecovery;runtimePacket:ProgressPin;initialExecution:ProgressPin;execution:ProgressPin;operatorSeal:ProgressPin;
  state:ProgressPin;stop:ProgressPin;ledger:ProgressPin;checkpoint:ProgressPin;carry:ProgressPin;pollGap:ProgressPin;canonicalWork:ProgressPin;adoption:ProgressPin;targetPacket:ProgressPin;
  startupStops?:readonly ControlledStartupStop[];distinctFollowup?:ProgressPin;acceptedCheckpoint?:ProgressPin;serverAdoption?:ProgressPin;preNativeAdmissionStop?:ProgressPin;nextServerAdoption?:ProgressPin;operationAmendment?:Readonly<{operationCap:62;normalCeiling:54;cleanupReserve:8;allocation:ProgressPin}>;
}>;
/** Separate from historical receipts. The later human decision binds this pin
 * and the target packet, so the descriptor must not contain that packet's hash. */
export type ControlledServerAdoption=Readonly<{
 purpose:'phase-c-exact-staging-server-adoption';version:1;environment:'staging';
 priorServerSource:string;serverSource:string;clientSource:string;verification:ProgressPin;
}>;
export type ControlledServerVerification=Readonly<{
 purpose:'phase-c-tested-server-adoption';version:1;priorServerSource:string;serverSource:string;
 ciHead:string;ciPassed:true;compatibilityPassed:true;restorationPassed:true;evidence:readonly ProgressPin[];
}>;
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v),canon=(v:any):any=>Array.isArray(v)?v.map(canon):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
function refuse(code:string):never{throw Object.assign(Error(code),{code});}
async function read(p:ProgressPin,parse=true){if(!p||!path.isAbsolute(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256))refuse('EXACT_CONTROLLED_PROGRESS_PIN_REQUIRED');const stat=await fs.lstat(p.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2000000)refuse('BOUNDED_CONTROLLED_PROGRESS_PIN_REQUIRED');const raw=await fs.readFile(p.path);if(hash(raw)!==p.sha256)refuse('CONTROLLED_PROGRESS_CHANGED');return{raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};}
async function inspectServerAdoption(r:ControlledProgressRecovery,target:any,priorServerSource:string,receipt:ActiveContinuationReceipt,accepted:AcceptedCheckpointCarry|undefined,retained?:ProgressPin){
 const changed=receipt.serverSource!==priorServerSource;
 if(retained){
  if(!accepted||!equal(r.serverAdoption,retained)||!equal(target.serverAdoption,retained))refuse('EXACT_RETAINED_SERVER_ADOPTION_REQUIRED');
  if(changed){
   const next=r.nextServerAdoption;
   if(receipt.version!==2||!next||next.sha256===retained.sha256||!equal(next,target.nextServerAdoption))refuse('EXACT_NEXT_SERVER_ADOPTION_REQUIRED');
   return inspectServerAdoptionProof(next,priorServerSource,receipt);
  }
 }
 if(Object.hasOwn(r,'nextServerAdoption')||Object.hasOwn(target,'nextServerAdoption'))refuse('UNEXPECTED_NEXT_SERVER_ADOPTION');
 if(retained)return;
 if(!changed){if(r.serverAdoption!==undefined||Object.hasOwn(target,'serverAdoption'))refuse('UNEXPECTED_CONTROLLED_SERVER_ADOPTION');return;}
 if(!accepted||!r.serverAdoption||!equal(r.serverAdoption,target.serverAdoption))refuse('EXACT_CONTROLLED_SERVER_ADOPTION_REQUIRED');
 return inspectServerAdoptionProof(r.serverAdoption,priorServerSource,receipt);
}
async function inspectServerAdoptionProof(proof:ProgressPin,priorServerSource:string,receipt:ActiveContinuationReceipt){
 const d=(await read(proof)).value;
 if(!object(d)||Object.keys(d).sort().join()!=='clientSource,environment,priorServerSource,purpose,serverSource,verification,version'
  ||d.purpose!=='phase-c-exact-staging-server-adoption'||d.version!==1||d.environment!=='staging'
  ||!/^[a-f0-9]{40}$/.test(priorServerSource)||!/^[a-f0-9]{40}$/.test(receipt.serverSource)
  ||d.priorServerSource!==priorServerSource||d.serverSource!==receipt.serverSource||d.clientSource!==receipt.clientSource)refuse('EXACT_CONTROLLED_SERVER_ADOPTION_REQUIRED');
 const v=(await read(d.verification)).value;
 if(!object(v)||Object.keys(v).sort().join()!=='ciHead,ciPassed,compatibilityPassed,evidence,priorServerSource,purpose,restorationPassed,serverSource,version'
  ||v.purpose!=='phase-c-tested-server-adoption'||v.version!==1||v.priorServerSource!==priorServerSource||v.serverSource!==receipt.serverSource
  ||v.ciHead!==receipt.serverSource||v.ciPassed!==true||v.compatibilityPassed!==true||v.restorationPassed!==true
  ||!Array.isArray(v.evidence)||v.evidence.length<1||v.evidence.length>8)refuse('EXACT_TESTED_SERVER_ADOPTION_REQUIRED');
 for(const evidence of v.evidence)await read(evidence,false);
 return proof.sha256;
}
function originalReceipt(e:any){const r=e?.receipt,start=Date.parse(r?.startUtc),end=Date.parse(r?.hardStopUtc);if(!object(r)||r.version!==1||r.ownerApproved!==true||r.modelCap!==64||r.ciPassed!==true||r.ciHead!==r.clientSource||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>5400000||e.window!==hash(JSON.stringify(r)))refuse('GENUINE_CONTROLLED_EXECUTION_REQUIRED');return r as ContinuationReceipt;}
type HistoryInput={releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery};
export async function inspectControlledProgressHistory(input:HistoryInput){
 if(input.recovery.preNativeAdmissionStop)return inspectPreNativeAdmissionStop(input,input.recovery.preNativeAdmissionStop);
 if(input.recovery.acceptedCheckpoint)return inspectAcceptedCheckpointHistory(input,inspectOriginalControlledProgressHistory);
 return inspectOriginalControlledProgressHistory(input);
}
function refuseAdmissionStop():never{ return refuse('EXACT_PRE_NATIVE_ADMISSION_STOP_REQUIRED'); }
function samePin(left:unknown,right:ProgressPin):boolean{
 return object(left)&&equal(left,right);
}
async function inspectPreNativeAdmissionStop(input:HistoryInput,proof:ProgressPin){
 const {releaseRoot,ledger,recovery:r}=input;
 const d=(await read(proof)).value;
 if(!r.acceptedCheckpoint||!r.serverAdoption||d.purpose!=='actual-phase-c-workflow-admission-stop-before-native-start'||
   d.reasonCode!=='EXACT_WORKFLOW_ADOPTION_SHAPE_REQUIRED'||d.originalErrorField!=='serverAdoptionSha256'||
   d.executionAllowed!==false||d.sealedWorkerExited!==true||d.acceptedSendRepeated!==false||
   d.hostsStarted!==0||d.claimsIssued!==0||d.modelCallsAdded!==0||d.modelCalls!==35||d.operations!==34||
   !equal(d.appendedRowKinds,['window','plan']))refuseAdmissionStop();
 const priorLedger=await ledger.inspectReadOnlyPrefix(d.previousLedger.path,d.previousLedger.sha256);
 const previous=await inspectAcceptedCheckpointHistory({...input,ledger:priorLedger},inspectOriginalControlledProgressHistory);
 if(!samePin(d.previousLedger,previous.priorLedger)||d.existingCheckpoint!==previous.workId||
   d.existingAttempts!==previous.acceptedCheckpoint.expectedAttempts)refuseAdmissionStop();

 const [p,seal,arm,e,stop,intake,guards,canonical]=await Promise.all(
  [d.packet,d.seal,d.arm,d.execution,d.stop,d.ownerIntake,d.postIntakeGuards,d.canonicalWork].map(async pin=>(await read(pin)).value));
 const start=Date.parse(e.receipt?.startUtc),ended=Date.parse(stop.observedAtUtc),checked=Date.parse(d.checkedAtUtc);
 const prior=r;
 const stoppedRecovery=p.controlledRecoveryBase;
 const historicalKeys=['runtimePacket','initialExecution','execution','operatorSeal','state','stop','ledger','checkpoint','carry','pollGap','distinctFollowup','acceptedCheckpoint','serverAdoption','operationAmendment','startupStops'] as const;
 if(!object(stoppedRecovery)||stoppedRecovery.preNativeAdmissionStop!==undefined||Object.hasOwn(stoppedRecovery,'nextServerAdoption')||
   historicalKeys.some(key=>!equal(stoppedRecovery[key],prior[key])))refuseAdmissionStop();
 const receipt=e.receipt as ActiveContinuationReceipt;
 if(!receipt||receipt.version!==2||receipt.ownerApproved!==true||receipt.modelCap!==64||receipt.ciPassed!==true||
   receipt.ciHead!==receipt.clientSource||receipt.lifetime!=='until-complete-or-cancel'||receipt.humanReview!=='before-claim'||
   Object.hasOwn(receipt,'hardStopUtc')||!equal(p.workflowPolicy,{lifetime:receipt.lifetime,humanReview:receipt.humanReview})||
   receipt.clientSource!==p.clientSource||receipt.serverSource!==p.serverSource||receipt.runnerSha256!==p.library?.sha256||
   receipt.packetSha256!==d.packet.sha256||e.window!==hash(JSON.stringify(receipt))||e.actualStartedAtUtc!==receipt.startUtc||
   e.purpose!=='actual-controlled-checkpoint-recovery'||!samePin(e.priorExecution,previous.priorExecution)||
   !samePin(e.carriedState,r.state)||!samePin(e.carriedCheckpoint,r.carry)||e.sealSha256!==d.seal.sha256||
   p.purpose!=='phase-c-prepared-controlled-progress-session'||path.resolve(p.oldKitRoot)!==path.resolve(releaseRoot)||
   p.sealPath!==d.seal.path||!samePin(seal.packet,d.packet)||seal.executionAuthorized!==false||
   !Number.isFinite(start)||!(start<=ended&&ended<=checked&&checked<=Date.now()))refuseAdmissionStop();
 if(stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='checked-controlled-progress-admission'||
   stop.gateComplete!==false||stop.packetSha256!==d.packet.sha256||d.observedStoppedAtUtc!==stop.observedAtUtc||
   arm.packetSha256!==d.packet.sha256||arm.sealSha256!==d.seal.sha256||arm.challenge!==p.ownerConsole?.challenge||
   arm.adoption?.sha256!==receipt.approvalReceiptSha256||path.resolve(arm.adoption.path)!==path.resolve(p.decisionPaths?.adoption)||
   !samePin(intake.canonicalWork,d.canonicalWork)||intake.packetSha256!==d.packet.sha256||intake.challenge!==arm.challenge||
   guards.sealSha256!==d.seal.sha256||guards.hostProof?.allSelectedHostsStopped!==true||
   guards.hostProof?.hostsStarted!==0||guards.hostProof?.claimsIssued!==0||guards.hostProof?.modelsAdded!==0||
   guards.resources?.admissionWorkRootUnused!==true)refuseAdmissionStop();
 const expectedFiles={arm:'ARM-APPROVED.private.json',execution:'controlled-execution.private.json',
  stop:'operator-stopped.private.json',failure:'operator-failure.private.log',ownerIntake:'owner-intake-saved.private.json',
  postIntakeGuards:'post-intake-guards.actual.private.json'};
 if(Object.entries(expectedFiles).some(([key,name])=>path.resolve(d[key].path)!==path.resolve(p.directory,name)))refuseAdmissionStop();
 const failure=(await read(d.failure,false)).raw.toString('utf8');
 if(!/EXACT_WORKFLOW_ADOPTION_SHAPE_REQUIRED/.test(failure)||!/\+\s+'serverAdoptionSha256'/.test(failure))refuseAdmissionStop();
 for(const name of ['owner-controls-context.private.json','owner-requests','processing-first-milestone.actual.json']){
  try{await fs.lstat(path.join(p.directory,name));refuseAdmissionStop();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 if((await fs.readdir(p.admissionWorkRoot)).length!==0)refuseAdmissionStop();
 await read(intake.rawPin,false);
 if(canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||canonical.activeWorkLeases!==0||
   canonical.activeCaseSessions!==0||canonical.work?.workId!==previous.workId||canonical.work?.caseId!==previous.caseId||
   canonical.work?.agentId!==previous.actorId||canonical.work?.status!=='retryable'||
   canonical.work?.attempts!==previous.acceptedCheckpoint.expectedAttempts||canonical.work?.processedAt!=null)refuseAdmissionStop();

 const [adoption,trusted,release]=await Promise.all([arm.adoption,arm.trustedDecision,arm.actualStagingRelease].map(async pin=>(await read(pin)).value));
 const serverAdoption=await inspectServerAdoption(stoppedRecovery,p,previous.originalReceipt.serverSource,receipt,previous.acceptedCheckpoint);
 if(!serverAdoption||adoption.serverAdoptionSha256!==serverAdoption||trusted.serverAdoptionSha256!==serverAdoption||
   adoption.owner!=='pjsk02'||adoption.ownerApproved!==true||adoption.packetSha256!==d.packet.sha256||
   adoption.clientSource!==receipt.clientSource||adoption.serverSource!==receipt.serverSource||
   adoption.acceptedCheckpointSha256!==r.acceptedCheckpoint.sha256||adoption.priorWindow!==previous.priorWindow||
   adoption.priorExecutionSha256!==previous.priorExecution.sha256||adoption.priorLedgerSha256!==previous.priorLedger.sha256||
   adoption.repeatOnboarding!==false||adoption.replayAcceptedSends!==false||adoption.repeatObservedControls!==false||
   adoption.currentModels!==35||adoption.currentOperations!==34||adoption.operationCap!==62||adoption.normalOperationCap!==54||
   adoption.cleanupReserve!==8||adoption.modelCap!==64||adoption.operationAllocationSha256!==r.operationAmendment?.allocation.sha256||
   trusted.trustedDirectHumanReply!==true||trusted.approvedPersistentWorkflow!==true||trusted.decisionId!==adoption.decisionId||
   trusted.sealSha256!==d.seal.sha256||trusted.packetSha256!==d.packet.sha256||
   release.candidateSource!==receipt.serverSource||release.packetSha256!==d.packet.sha256||
   release.sourceAdoptionDecisionId!==adoption.decisionId||release.sourceAdoptionDecisionSha256!==arm.adoption.sha256||
   release.registryManifestReadbackVerified!==true||release.stagingHealthVerified!==true)refuseAdmissionStop();
 if(!/^[A-Za-z0-9_-]{8,100}$/.test(adoption.decisionId)||
   path.resolve(d.consumed.path)!==path.resolve(releaseRoot,'phase-c-recovery-time-'+hash('pjsk02\0'+adoption.decisionId)+'.used.json')||
   path.resolve(d.admission.path)!==path.resolve(releaseRoot,'phase-c-controlled-progress-'+previous.priorWindow+'.used.json'))refuseAdmissionStop();
 const [decision,admission]=await Promise.all([d.consumed,d.admission].map(async pin=>(await read(pin)).value));
 if(decision.purpose!=='phase-c-one-use-controlled-progress-recovery'||decision.approvalSha256!==arm.adoption.sha256||
   decision.decisionId!==adoption.decisionId||decision.window!==e.window||decision.priorWindow!==previous.priorWindow||
   decision.timeMode!==receipt.lifetime||admission.purpose!=='phase-c-one-use-controlled-progress'||
   admission.priorWindow!==previous.priorWindow||admission.nextWindow!==e.window||admission.stateSha256!==r.state.sha256||
   admission.ledgerSha256!==previous.priorLedger.sha256)refuseAdmissionStop();

 const activeActionLedger=path.join(releaseRoot,'phase-c-cumulative-actions.jsonl');
 const [rows,actions,priorActions]=await Promise.all([
  ledger.readInspectionBytes(),read(d.actionLedger,false),read(r.history.actionLedger,false),
 ]);
 // This pin originally named the live ledger. A later admitted workflow can
 // inspect its exact anchored prefix without rewriting the original receipt.
 const frozen=path.resolve(d.actualLedger.path)===path.resolve(ledger.filename)
  ? rows : (await read(d.actualLedger,false)).raw;
 const prefix=await priorLedger.readInspectionBytes();
 if(hash(frozen)!==d.actualLedger.sha256||!rows.equals(frozen)||!rows.subarray(0,prefix.length).equals(prefix)||!rows.toString().endsWith('\n')||
   hash(rows)!==ledger.contentSha256||ledger.window!==e.window||ledger.reviewedGraphApprovalRaw!==e.graphApprovalRaw||
   hashReviewedContinuationPlan(p.reviewedGraph)!==ledger.reviewedPlan?.planSha256||
   path.resolve(d.actionLedger.path)!==path.resolve(activeActionLedger)||!actions.raw.equals(priorActions.raw))refuseAdmissionStop();
 const suffix=rows.subarray(prefix.length),append=suffix.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
 if(append.length!==2||append[0].kind!=='window'||append[1].kind!=='plan'||append.some(row=>row.window!==e.window)||
   append[0].proof?.approvalReceiptHash!==arm.adoption.sha256||append[1].proof?.graphApprovalRaw!==e.graphApprovalRaw||
   hash(suffix)!==d.appendedRowsSha256)refuseAdmissionStop();
 const before=priorLedger.snapshot(),now=ledger.snapshot();
 if(now.chargedAttempts!==35||now.pending!==0||now.unresolvedDispatches!==0||
   (['chargedAttempts','knownDispatchedRequests','knownOpenClawDispatches','pending','unresolvedDispatches'] as const)
    .some(key=>now[key]!==before[key]))refuseAdmissionStop();
 return {...previous,priorWindow:e.window,priorExecution:d.execution as ProgressPin,priorLedger:d.actualLedger as ProgressPin,
  originalReceipt:receipt,currentLedgerSha256:hash(rows),metadataReceipts:[...previous.metadataReceipts,receipt],
  retainedServerAdoption:r.serverAdoption,preNativeMetadataPrefix:{ledger:previous.priorLedger,receipt:previous.originalReceipt}};
}
async function inspectOriginalControlledProgressHistory(input:HistoryInput){
 const{recovery:r,ledger}=input,p=(await read(r.runtimePacket)).value,first=(await read(r.initialExecution)).value,current=(await read(r.execution)).value,
   a=originalReceipt(first),b=originalReceipt(current),seal=(await read(r.operatorSeal)).value,state=(await read(r.state)).value,stop=(await read(r.stop)).value,c=(await read(r.checkpoint)).value;
 if(path.resolve(input.releaseRoot)!==path.resolve(p.oldKitRoot??'')||a.packetSha256!==r.runtimePacket.sha256||b.packetSha256!==a.packetSha256
   ||a.clientSource!==p.clientSource||a.runnerSha256!==p.library?.sha256||a.serverSource!==p.serverSource||!equal(current.original,first)
   ||['clientSource','runnerSha256','packetSha256','serverSource','ciHead','ciPassed','modelCap'].some(k=>a[k as keyof ContinuationReceipt]!==b[k as keyof ContinuationReceipt])
   ||current.sealSha256!==r.operatorSeal.sha256||seal.original?.packet?.sha256!==r.runtimePacket.sha256||stop.packetSha256!==seal.packet?.sha256
   ||stop.phase!=='remaining-native-program'||stop.gateComplete!==false||!Number.isFinite(Date.parse(stop.observedAtUtc))
   ||Date.parse(stop.observedAtUtc)<Date.parse(b.startUtc)||Date.parse(stop.observedAtUtc)>Date.now())refuse('ACTUAL_CONTROLLED_STOP_REQUIRED');
 const operator=(await read(seal.packet)).value;if(operator.original?.packet?.sha256!==r.runtimePacket.sha256||operator.recovery?.source!==current.recoveryImplementation?.source
   ||operator.recovery?.library?.sha256!==current.recoveryImplementation?.library?.sha256)refuse('ACTUAL_CONTROLLED_STOP_REQUIRED');
 const{actionLedger:_,currentInventory:__,time:___,...history}=r.history,known=(await read(p.resumption?.history)).value;
 if(!equal(history,known))refuse('EXACT_CONTROLLED_ANCESTRY_REQUIRED');
 const startupFrames=await readControlledStartupFrames(r.startupStops),metadataReceipts=[a,b,...startupFrames.map(f=>originalReceipt(f.execution))];
 const historical=await inspectStoppedProgressHistory({releaseRoot:input.releaseRoot,recovery:r.history,ledger,nextStart:Date.parse(a.startUtc)},metadataReceipts);
 const frozen=(await read(r.ledger,false)).raw,rows=await ledger.readInspectionBytes();
 if(!rows.subarray(0,frozen.length).equals(frozen)||!startupFrames.length&&!rows.equals(frozen)||rows.toString().trimEnd().split('\n').length!==frozen.toString().trimEnd().split('\n').length+2*startupFrames.length||hash(rows)!==ledger.contentSha256)refuse('CONTROLLED_LEDGER_CHANGED');
 const tail=rows.toString().trimEnd().split('\n').map(x=>JSON.parse(x));
 for(const e of[first,current]){const plan=tail.find((x:any)=>x.kind==='plan'&&x.window===e.window);if(plan?.proof?.graphApprovalRaw!==e.graphApprovalRaw)refuse('ACTUAL_CONTROLLED_GRAPH_REQUIRED');}
 if(state.window!==current.window||state.planSha256!==hash(JSON.stringify(canon({...p.program,windowId:current.window})))
   ||!object(state.started)||Object.keys(state.started).join()!=='openclaw'||!object(state.results)||Object.keys(state.results).length
   ||!object(state.effects)||Object.keys(state.effects).length||!object(state.controlProofs)||Object.keys(state.controlProofs).join()!=='openclaw')refuse('ZERO_NATIVE_CONTROLLED_STATE_REQUIRED');
 const work=state.started.openclaw,shared=state.taskReceipts?.shared,carried=(await read(r.history.priorState)).value;
 if(!/^msg_[A-Za-z0-9_-]+$/.test(work?.workId)||work.caseId!==ledger.reviewedPlan?.flowCases.openclaw
   ||shared?.state!=='accepted'||shared.messageId!==work.workId||shared.caseId!==work.caseId
   ||!equal(state.carriedProgress,carried.carriedProgress)||!equal(shared,carried.taskReceipts?.shared)
   ||state.carriedTaskReceipts?.shared?.acceptedSendRepeated!==false||state.carriedTaskReceipts.shared.receiptDigest!==hash(JSON.stringify(canon(shared))))refuse('RETAINED_ACCEPTED_WORK_REQUIRED');
 const controls=state.controlProofs.openclaw;
 for(const mode of['pause','expiry']){const proof=controls?.[mode];if(proof?.mode!==mode||proof.hostId!=='openclaw'||proof.workId!==work.workId||proof.caseId!==work.caseId
   ||proof.classification!=='control_observed_awaiting_final_inventory'||proof.modelCallsAdded!==0||proof.canonicalProcessed!==false
   ||!Array.isArray(proof.probes)||!proof.probes.length||!object(proof.evidence))refuse('ACTUAL_CARRIED_CONTROL_PROOF_REQUIRED');
   await read({path:proof.evidence.file,sha256:proof.evidence.sha256});
   for(const action of proof.actions??[]){const receipt=(await read({path:action.receiptPath,sha256:action.sha256})).value;
    if(!equal(receipt,action.receipt)||receipt.window!==current.window||receipt.humanConfirmed!==true||receipt.agentId!==p.actors.openclaw.agentId||receipt.installationId!==p.actors.openclaw.installationId)refuse('ACTUAL_PERSONAL_CONTROL_RECEIPT_REQUIRED');}
 }
 const checked=Date.parse(c.checkedAtUtc);if(c.purpose!=='actual-post-control-stop-evidence-no-recovery'||!Number.isFinite(checked)||checked<Date.parse(stop.observedAtUtc)||checked>Date.now()
   ||c.models!==ledger.snapshot().chargedAttempts||c.pending!==0||c.unresolved!==0||c.sharedNativeJournalAbsent!==true
   ||c.meterListening!==false||c.nativeGatewayListening!==false||c.nativeProxyListening!==false||c.gatewayProxyDifferent!==true
   ||!equal(c.controlProofs.openclaw,controls)||!Array.isArray(c.selected)||c.selected.length!==3||!['je1','je2','testowner'].every(role=>c.selected.filter((x:any)=>x.role===role&&x.stopped===true).length===1))refuse('ACTUAL_CONTROLLED_CLEANUP_REQUIRED');
 const journals=p.program.originalJournalHashes;if(!Array.isArray(journals)||journals.length!==9||!Array.isArray(c.originalJournals)||c.originalJournals.length!==9)refuse('EXACT_ORIGINAL_JOURNALS_REQUIRED');
 for(const j of journals){if(!['je1','je2','testowner'].includes(j.role)||path.basename(j.file)!==j.file||c.originalJournals.filter((x:any)=>x.role===j.role&&x.file===j.file&&x.sha256===j.sha256&&x.unchanged===true).length!==1)refuse('EXACT_ORIGINAL_JOURNALS_REQUIRED');await read({path:path.join(p.states[j.role],'scoped-runs',j.file),sha256:j.sha256},false);}
 const filename=path.join(p.states.openclaw,'scoped-runs',work.workId+'.json');if(!startupFrames.at(-1)?.proof.preTarget?.unforwarded)try{await fs.lstat(filename);refuse('NATIVE_JOURNAL_MUST_BE_ABSENT');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const d=(await read(r.carry)).value;
 if(d.purpose!=='phase-c-post-control-no-native-checkpoint-review-only'||d.executionAllowed!==false||d.newAuthorityGranted!==false
   ||d.execution?.sha256!==r.execution.sha256||d.programState?.sha256!==r.state.sha256||d.modelLedger?.sha256!==r.ledger.sha256
   ||d.originalPacket?.sha256!==r.runtimePacket.sha256||d.actualStopObservation?.sha256!==r.checkpoint.sha256
   ||d.shared?.workId!==work.workId||d.shared.caseId!==work.caseId)refuse('EXACT_CARRIED_OBSERVATIONS_REQUIRED');
 for(const mode of['pause','expiry']){const scope=(await read(d.controls?.[mode]?.scope)).value,observed=(await read(d.controls?.[mode]?.observed)).value,proof=controls[mode];
   if(observed.kind!=='control-observed'||observed.mode!==mode||observed.window!==current.window||observed.workId!==work.workId||observed.caseId!==work.caseId
     ||observed.modelCallsAdded!==0||observed.canonicalProcessed!==false||observed.sessionId!==scope.session?.id||observed.fence!==scope.session?.fence
     ||proof.sessionId!==observed.sessionId||proof.fence!==observed.fence||scope.workId!==work.workId||scope.caseId!==work.caseId||scope.window!==current.window
     ||scope.session.agentId!==p.actors.openclaw.agentId||scope.session.installationId!==p.actors.openclaw.installationId||Date.parse(scope.session.expiresAt)-Date.parse(scope.session.createdAt)!==900000
     ||observed.stopped?.status!=='stopped_before_native'||observed.stopped.modelPrompts!==0||observed.stopped.journalAbsent!==true
     ||observed.stopped.modelChargedAttemptsBefore!==ledger.snapshot().chargedAttempts||observed.stopped.modelChargedAttemptsAfter!==ledger.snapshot().chargedAttempts)refuse('ACTUAL_CARRIED_CONTROL_PROOF_REQUIRED');
   if(mode==='pause'){if(!Array.isArray(observed.probes)||observed.probes.map((x:any)=>x.stage).join()!=='paused,resumed'
     ||observed.probes[0].settlement?.code!=='AGENT_PAUSED'||observed.probes[1].settlement?.code!=='WORK_LEASE_STALE'
     ||JSON.parse(observed.probes[0].settlement.status.raw).state!=='paused'||JSON.parse(observed.probes[1].settlement.status.raw).state!=='active')refuse('ACTUAL_CARRIED_PAUSE_RESUME_REQUIRED');}
   else if(observed.fence<=controls.pause.fence||observed.probes?.length!==1||observed.probes[0].stage!=='expired'||observed.probes[0].scope?.code!=='CASE_SESSION_EXPIRED'
     ||observed.probes[0].settlement?.code!=='WORK_LEASE_STALE'||Date.parse(observed.observedAtUtc)<=Date.parse(scope.session.expiresAt)
     ||Date.parse(observed.observedAtUtc)<=Date.parse(observed.probes[0].frozenLeaseExpiresAt))refuse('ACTUAL_CARRIED_EXPIRY_REQUIRED');
 }
 const poll=(await read(r.pollGap)).value,lost=(await read(d.events?.actual_sdk_poll_response_lost)).value;
 if(d.events?.actual_sdk_poll_gap_recovered?.sha256!==r.pollGap.sha256||lost.kind!=='actual_sdk_poll_response_lost'||poll.kind!=='actual_sdk_poll_gap_recovered'
   ||lost.window!==current.window||poll.window!==current.window||lost.role!=='openclaw'||poll.role!=='openclaw'||lost.workId!==work.workId||poll.workId!==work.workId
   ||poll.caseId!==work.caseId||poll.modelCallsAdded!==0||poll.lost?.responseSha256!==lost.responseSha256||poll.lost.path!==poll.recovered?.path||poll.lost.query!==poll.recovered.query
   ||!Array.isArray(poll.lost.eventIds)||!poll.lost.eventIds.every((id:any)=>poll.recovered.eventIds.includes(id)))refuse('ACTUAL_POLL_GAP_PROOF_REQUIRED');
 const settlement=(await read(d.events?.canonical_settlement)).value;if(settlement.kind!=='canonical_settlement'||settlement.workId!==work.workId||settlement.status!=='retryable'||settlement.operation!=='fail')refuse('PRIOR_RETRYABLE_SETTLEMENT_REQUIRED');
 const startup=await inspectControlledStartupFrames({releaseRoot:input.releaseRoot,recovery:r,frames:startupFrames,ledger,rows,frozen,controlWindow:current.window,journals:p.program.originalJournalHashes,states:p.states});
 return{...historical,originalReceipt:startup?.receipt??b,priorWindow:startup?.window??current.window,currentLedgerSha256:hash(rows),stateSha256:r.state.sha256,workId:work.workId,caseId:work.caseId,
   actorId:p.actors.openclaw.agentId,carriedControlProofs:controls,carriedControlSource:b.clientSource,pollGapSha256:r.pollGap.sha256,runtimePacket:p,initialReceipt:a,metadataReceipts,
   priorExecution:startup?.proof.execution??r.execution,priorLedger:startup?.proof.ledger??r.ledger,startup,acceptedCheckpoint:undefined as AcceptedCheckpointCarry|undefined};
}
type ControlledInspectionInput={releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery;receipt:ActiveContinuationReceipt;preflight:StoppedProgressPreflight;expected:{clientSource:string;serverSource:string;runnerSha256:string;packetSha256:string;priorLedgerSha256:string}};
export async function inspectControlledProgress(input:ControlledInspectionInput){
 return inspectControlledProgressAuthority(input);
}
async function inspectControlledProgressAuthority(input:ControlledInspectionInput,consumed?:ProgressPin){
 const{recovery:r,receipt:n,ledger,preflight:p,expected:e}=input,h=await inspectControlledProgressHistory(input),a=h.initialReceipt;
 const metadataPrefix='preNativeMetadataPrefix' in h ? h.preNativeMetadataPrefix as {ledger:ProgressPin;receipt:ActiveContinuationReceipt} : undefined;
 if(metadataPrefix&&n.version!==2)refuse('EXACT_PRE_NATIVE_ADMISSION_STOP_REQUIRED');
 // The stop inspector verified the two new metadata rows separately. Keep the
 // existing native-progress verifier on its previously approved exact prefix.
 const stoppedLedger=metadataPrefix?await ledger.inspectReadOnlyPrefix(metadataPrefix.ledger.path,metadataPrefix.ledger.sha256):ledger;
 const metadataReceipts=metadataPrefix?h.metadataReceipts.slice(0,-1):h.metadataReceipts;
 const stoppedReceipt=metadataPrefix?.receipt??h.originalReceipt;
 const verifiedWorkflowBootstrap=n.version===2&&h.acceptedCheckpoint&&stoppedReceipt.version===2?stoppedReceipt:undefined;
 await inspectStoppedProgress({releaseRoot:input.releaseRoot,ledger:stoppedLedger,recovery:r.history,receipt:a,preflight:p,expected:{...e,clientSource:a.clientSource,serverSource:a.serverSource,runnerSha256:a.runnerSha256,packetSha256:a.packetSha256},metadataReceipts},verifiedWorkflowBootstrap);
 const canonical=(await read(r.canonicalWork)).value,w=canonical?.work,now=Date.now(),accepted=h.acceptedCheckpoint,unforwarded=accepted?undefined:h.startup?.proof.preTarget?.unforwarded;
 if(canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||Date.parse(canonical.checkedAt)!==p.checkedAtMs||canonical.activeWorkLeases!==0
   ||w?.workId!==h.workId||w.caseId!==h.caseId||w.agentId!==h.actorId||w.status!==(unforwarded?'failed':'retryable')||!Number.isSafeInteger(w.attempts)||w.attempts<1
   ||w.retryAt!=null&&(!Number.isFinite(Date.parse(w.retryAt))||Date.parse(w.retryAt)>now)
   ||!Array.isArray(w.sessions)||!accepted&&!w.sessions.length||w.sessions.some((s:any)=>s.status!=='ended'))refuse('FRESH_CANONICAL_RETRYABLE_WORK_REQUIRED');
 if(unforwarded&&(w.attempts!==5||w.failure?.retryable!==false||w.failure.reasonCode!=='HANDLER_FAILED'||canonical.activeCaseSessions!==0))refuse('FAILED_ORIGINAL_MUST_REMAIN_FAILED');
 if(accepted){const old=canonical.retainedOriginal;
  if(canonical.activeCaseSessions!==0||w.attempts!==accepted.expectedAttempts||w.failure?.retryable!==true||w.failure.reasonCode!=='HANDLER_FAILED'||w.messageStatus!=='acknowledged'||w.processedAt!=null
   ||old?.workId!==accepted.retainedOriginalWorkId||old.caseId!==h.caseId||old.agentId!==h.actorId||old.status!=='failed'||old.attempts!==5||old.failure?.retryable!==false||old.failure.reasonCode!=='HANDLER_FAILED')refuse('FRESH_ACCEPTED_CHECKPOINT_AND_FAILED_ORIGINAL_REQUIRED');
  await inspectAcceptedCheckpointSessions(w,canonical,accepted.endedSessionsProof);
 }
 let distinctFollowup:any;
 if(unforwarded){
  if(!r.distinctFollowup)refuse('EXPLICIT_DISTINCT_FOLLOWUP_REQUIRED');distinctFollowup=(await read(r.distinctFollowup)).value;
  const frozen=(await readUnforwardedPin(unforwarded)).value,selected=(await read(h.startup!.proof.preTarget!.selection)).value;
  if(distinctFollowup.version!==1||distinctFollowup.retainedFailedWorkId!==h.workId||distinctFollowup.retainedFailedJournalSha256!==frozen.journal.sha256
   ||distinctFollowup.caseId!==h.caseId||distinctFollowup.senderRole!=='testowner'||distinctFollowup.recipientRole!=='openclaw'
   ||distinctFollowup.senderAgentId!==(h.runtimePacket.actors.testowner.agentId??h.runtimePacket.actors.testowner)||distinctFollowup.recipientAgentId!==h.actorId
   ||typeof distinctFollowup.text!=='string'||!distinctFollowup.text.trim()||distinctFollowup.text.length>2000||selected.messages.some((m:any)=>m.text===distinctFollowup.text)
   ||!/^[a-f0-9-]{36}$/.test(distinctFollowup.requestId)||distinctFollowup.additionalOperationReservations!==1||distinctFollowup.newCasesAdded!==0||distinctFollowup.newInstallationsAdded!==0||distinctFollowup.newAssetsAdded!==0
   ||distinctFollowup.requiresActualHumanSendConfirmation!==true||distinctFollowup.acceptedSendRepeated!==false||distinctFollowup.failedWorkRequeued!==false)refuse('EXPLICIT_DISTINCT_FOLLOWUP_REQUIRED');
 }else if(r.distinctFollowup&&!accepted)refuse('UNFORWARDED_STOP_REQUIRED_FOR_DISTINCT_FOLLOWUP');
 if(unforwarded&&p.conservativeMessages+21>52&&!r.operationAmendment)refuse('EXACT_OPERATION_AMENDMENT_REQUIRED');
 let operationBounds={operationCap:60,normalCeiling:52,cleanupReserve:8};
 if(accepted&&!r.operationAmendment)refuse('EXACT_OPERATION_AMENDMENT_REQUIRED');
 if(r.operationAmendment){
  const amendment=r.operationAmendment,allocation=(await read(amendment.allocation)).value;
  if(((!unforwarded||!distinctFollowup)&&!accepted)||Object.keys(amendment).sort().join()!=='allocation,cleanupReserve,normalCeiling,operationCap'||amendment.operationCap!==62||amendment.normalCeiling!==54||amendment.cleanupReserve!==8)refuse('EXACT_OPERATION_AMENDMENT_REQUIRED');
  if(accepted){const originalAllocation=(await read(accepted.originalAllocation)).value;
   if(!Array.isArray(originalAllocation.allocations)||originalAllocation.allocations.length!==10||originalAllocation.allocations[0].minimumReservations!==1||originalAllocation.minimumAdditionalReservations!==21
    ||originalAllocation.currentConservativeReservations!==33||originalAllocation.newFollowupIncluded!==true||originalAllocation.minimumNormalTotal!==54||originalAllocation.normalCeiling!==54||originalAllocation.cleanupReserve!==8||originalAllocation.overallCeiling!==62
    ||originalAllocation.allocations.some((x:any)=>typeof x.item!=='string'||!x.item||!Number.isSafeInteger(x.minimumReservations)||x.minimumReservations<1)||originalAllocation.allocations.reduce((sum:number,x:any)=>sum+x.minimumReservations,0)!==21
    ||allocation.currentConservativeReservations!==p.conservativeMessages||p.conservativeMessages!==34||allocation.acceptedFollowupCarried!==true||allocation.newFollowupIncluded!==false||allocation.previousAllocationSha256!==accepted.originalAllocation.sha256
    ||!equal(allocation.allocations,originalAllocation.allocations.slice(1))||allocation.allocations.reduce((sum:number,x:any)=>sum+x.minimumReservations,0)!==20||allocation.minimumAdditionalReservations!==20
    ||allocation.minimumNormalTotal!==54||allocation.normalCeiling!==54||allocation.cleanupReserve!==8||allocation.overallCeiling!==62)refuse('EXACT_OPERATION_AMENDMENT_REQUIRED');
  }else if(
   allocation.currentConservativeReservations!==p.conservativeMessages||allocation.newFollowupIncluded!==true||!Array.isArray(allocation.allocations)||allocation.allocations.length!==10
   ||allocation.allocations.some((x:any)=>typeof x.item!=='string'||!x.item||!Number.isSafeInteger(x.minimumReservations)||x.minimumReservations<1)
   ||allocation.allocations.reduce((sum:number,x:any)=>sum+x.minimumReservations,0)!==21||allocation.minimumAdditionalReservations!==21||p.conservativeMessages+21>54
   ||allocation.minimumNormalTotal!==p.conservativeMessages+21||allocation.normalCeiling!==54||allocation.cleanupReserve!==8||allocation.overallCeiling!==62)refuse('EXACT_OPERATION_AMENDMENT_REQUIRED');
  operationBounds={operationCap:62,normalCeiling:54,cleanupReserve:8};
 }
 const target=(await read(r.targetPacket)).value,approval=(await read(r.adoption)).value,old=h.originalReceipt,start=Date.parse(n.startUtc),end=n.version===1?Date.parse(n.hardStopUtc):undefined;
 const workflow=n.version===2&&n.lifetime==='until-complete-or-cancel'&&n.humanReview==='before-claim'&&!Object.hasOwn(n,'hardStopUtc');
 const retainedServerAdoption='retainedServerAdoption' in h ? h.retainedServerAdoption as ProgressPin : undefined;
 const serverAdoptionSha256=await inspectServerAdoption(r,target,old.serverSource,n,accepted,retainedServerAdoption);
 if(!(n.version===1||workflow)||n.ownerApproved!==true||n.modelCap!==64||n.ciHead!==n.clientSource||n.ciPassed!==true||n.clientSource!==e.clientSource||n.serverSource!==e.serverSource
   ||n.runnerSha256!==e.runnerSha256||n.packetSha256!==e.packetSha256||n.packetSha256!==r.targetPacket.sha256||n.approvalReceiptSha256!==r.adoption.sha256
   ||!Number.isFinite(start)||start>now||!workflow&&(!Number.isFinite(end)||end!<=now||end!<=start||end!-start>5400000)||!/^[a-f0-9]{40}$/.test(n.clientSource)||!/^[a-f0-9]{64}$/.test(n.runnerSha256)
   ||target.clientSource!==n.clientSource||target.serverSource!==n.serverSource||target.library?.sha256!==n.runnerSha256||path.resolve(target.oldKitRoot??'')!==path.resolve(input.releaseRoot)
   ||target.carriedStateSha256!==r.state.sha256||hashReviewedContinuationPlan(target.reviewedGraph)!==ledger.reviewedPlan?.planSha256
   ||workflow&&(target.workflowPolicy?.lifetime!=='until-complete-or-cancel'||target.workflowPolicy.humanReview!=='before-claim'))refuse('EXACT_CONTROLLED_SOURCE_ADOPTION_REQUIRED');
 const exact={purpose:'phase-c-explicit-controlled-progress-recovery',version:1,owner:'pjsk02',ownerApproved:true,priorWindow:h.priorWindow,priorExecutionSha256:h.priorExecution.sha256,priorStateSha256:r.state.sha256,
   priorLedgerSha256:h.priorLedger.sha256,checkpointSha256:r.checkpoint.sha256,carrySha256:r.carry.sha256,
   ...(h.startup?{startupStopSha256:h.startup.proof.stop.sha256,startupCheckpointSha256:h.startup.proof.checkpoint.sha256,startupPacketSha256:h.startup.proof.packet.sha256}:{}),
   clientSource:n.clientSource,serverSource:n.serverSource,runnerSha256:n.runnerSha256,packetSha256:n.packetSha256,...(serverAdoptionSha256?{serverAdoptionSha256}:{}),
   modelCap:64,operationCap:operationBounds.operationCap,caseCap:9,installationCap:5,assetCap:6,currentModels:ledger.snapshot().chargedAttempts,currentOperations:p.conservativeMessages,currentCanonicalMessages:p.canonicalEffects,currentCases:p.cases,currentAssets:p.assets,
   repeatOnboarding:false,replayAcceptedSends:false,repeatObservedControls:false,...(unforwarded?{distinctFollowupSha256:r.distinctFollowup!.sha256,preserveFailedOriginal:true,...(r.operationAmendment?{normalOperationCap:54,cleanupReserve:8,operationAllocationSha256:r.operationAmendment.allocation.sha256}: {})}: {}),
   ...(accepted?{acceptedCheckpointSha256:r.acceptedCheckpoint!.sha256,preserveFailedOriginal:true,normalOperationCap:54,cleanupReserve:8,operationAllocationSha256:r.operationAmendment!.allocation.sha256}: {})};
 const timeKeys=workflow?['lifetime','humanReview']:['maximumIntervalMs'];
 if(Object.keys(approval).sort().join()!==[...Object.keys(exact),'decisionId','receivedAtUtc','timeMode',...timeKeys].sort().join()||Object.entries(exact).some(([k,v])=>approval[k]!==v)
   ||typeof approval.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(approval.decisionId)||!Number.isFinite(Date.parse(approval.receivedAtUtc))||Date.parse(approval.receivedAtUtc)>now)refuse('EXACT_CONTROLLED_RECOVERY_DECISION_REQUIRED');
 if(workflow){if(approval.timeMode!=='until-complete-or-cancel'||approval.lifetime!==n.lifetime||approval.humanReview!==n.humanReview||start<Date.parse(approval.receivedAtUtc)||start<Date.parse(old.startUtc))refuse('EXPLICIT_WORKFLOW_APPROVAL_REQUIRED');}
 else if(approval.timeMode==='same-fixed'){if(old.version!==1||start!==Date.parse(old.startUtc)||end!==Date.parse(old.hardStopUtc)||approval.maximumIntervalMs!==5400000)refuse('ORIGINAL_CONTROLLED_DEADLINE_REQUIRED');}
 else if(approval.timeMode!=='new-interval'||start<Date.parse(approval.receivedAtUtc)||start<Date.parse(old.startUtc)||!Number.isSafeInteger(approval.maximumIntervalMs)||approval.maximumIntervalMs<1||approval.maximumIntervalMs>5400000||end!-start>approval.maximumIntervalMs)refuse('EXPLICIT_NEW_CONTROLLED_INTERVAL_REQUIRED');
 const marker=path.join(path.resolve(input.releaseRoot),'phase-c-recovery-time-'+hash('pjsk02\0'+approval.decisionId)+'.used.json');
 const decision={purpose:'phase-c-one-use-controlled-progress-recovery',decisionId:approval.decisionId,approvalSha256:r.adoption.sha256,priorWindow:h.priorWindow,window:hash(JSON.stringify(n)),timeMode:approval.timeMode};
 if(consumed){
  if(path.resolve(consumed.path)!==marker||!equal((await read(consumed)).value,decision))refuse('EXACT_CONSUMED_WORKFLOW_REQUIRED');
 }else try{await fs.lstat(marker);refuse('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return{...h,distinctFollowup,operationBounds,async consume(){
  if(consumed)refuse('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');
  const f=await fs.open(marker,'wx',0o600);
  try{await f.writeFile(JSON.stringify(decision));await f.sync();}finally{await f.close();}
 }};
}

export type AdmittedWorkflowStop=Readonly<{
 previousLedger:ProgressPin;currentLedgerSha256:string;execution:ProgressPin;stop:ProgressPin;
 admission:ProgressPin;consumed:ProgressPin;
}>;

/** A failed pre-native startup can reattach only to its already admitted
 * workflow. Both original one-use receipts and the live ledger stay intact. */
export async function inspectAdmittedControlledWorkflow(input:ControlledInspectionInput,proof:AdmittedWorkflowStop){
 const {ledger,receipt,recovery:r,releaseRoot}=input;
 const target=(await read(r.targetPacket)).value;
 const directory=path.resolve(target.directory);
 const window=hash(JSON.stringify(receipt));
 if(receipt.version!==2||ledger.window!==window||ledger.contentSha256!==proof.currentLedgerSha256||
   !ledger.reviewedPlan||ledger.hasNativeHistorySinceWindow(window)||
   path.resolve(proof.execution.path)!==path.join(directory,'controlled-execution.private.json')||
   path.resolve(proof.stop.path)!==path.join(directory,'operator-stopped.private.json'))refuse('EXACT_STOPPED_ADMITTED_WORKFLOW_REQUIRED');
 const [execution,stop]=await Promise.all([proof.execution,proof.stop].map(async pin=>(await read(pin)).value));
 if(execution.purpose!=='actual-controlled-checkpoint-recovery'||execution.window!==window||
   !equal(execution.receipt,receipt)||execution.actualStartedAtUtc!==receipt.startUtc||
   !equal(execution.carriedState,r.state)||!equal(execution.carriedCheckpoint,r.carry)||
   stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='owned-runtime-startup'||
   stop.gateComplete!==false||stop.packetSha256!==r.targetPacket.sha256||
   !Number.isFinite(Date.parse(stop.observedAtUtc))||Date.parse(stop.observedAtUtc)<Date.parse(receipt.startUtc))refuse('EXACT_STOPPED_ADMITTED_WORKFLOW_REQUIRED');
 for(const name of ['owner-controls-context.private.json','owner-requests','actual-events.private.jsonl','openclaw-evidence']){
  try{await fs.lstat(path.join(directory,name));refuse('NATIVE_WORKFLOW_ALREADY_STARTED');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 const prefix=await ledger.inspectReadOnlyPrefix(proof.previousLedger.path,proof.previousLedger.sha256);
 const inspection=await inspectControlledProgressAuthority({...input,ledger:prefix},proof.consumed);
 const expectedAdmission=path.resolve(releaseRoot,'phase-c-controlled-progress-'+inspection.priorWindow+'.used.json');
 if(path.resolve(proof.admission.path)!==expectedAdmission||!equal((await read(proof.admission)).value,{
  purpose:'phase-c-one-use-controlled-progress',priorWindow:inspection.priorWindow,nextWindow:window,
  stateSha256:inspection.stateSha256,ledgerSha256:inspection.currentLedgerSha256,
 }))refuse('EXACT_CONSUMED_WORKFLOW_REQUIRED');
 if(!samePin(execution.priorExecution,inspection.priorExecution))refuse('EXACT_STOPPED_ADMITTED_WORKFLOW_REQUIRED');
 const current=await ledger.readInspectionBytes();
 const original=await prefix.readInspectionBytes();
 const appended=current.subarray(original.length).toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
 if(hash(current)!==proof.currentLedgerSha256||appended.length!==2||appended[0].kind!=='window'||
   appended[1].kind!=='plan'||appended.some(row=>row.window!==window)||
   appended[0].proof?.approvalReceiptHash!==receipt.approvalReceiptSha256||
   appended[1].proof?.graphApprovalRaw!==execution.graphApprovalRaw||
   ledger.reviewedGraphApprovalRaw!==execution.graphApprovalRaw)refuse('EXACT_ADMISSION_LEDGER_REQUIRED');
 const before=prefix.snapshot(),after=ledger.snapshot();
 if(after.pending!==0||after.unresolvedDispatches!==0||
   (['chargedAttempts','knownDispatchedRequests','knownOpenClawDispatches'] as const).some(key=>before[key]!==after[key]))
  refuse('NATIVE_WORKFLOW_ALREADY_STARTED');
 return inspection;
}
