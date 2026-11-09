// A retry of ONE already accepted checkpoint after a zero-dispatch startup stop.
// This inspector is read-only. It never sends work, modifies journals or grants time.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RequestBudgetLedger} from './request-budget';
import {hashReviewedContinuationPlan} from './continuation-plan';
import {readUnforwardedPin} from './controlled-unforwarded';
import type {ControlledProgressRecovery} from './controlled-progress';
import type {ContinuationReceipt} from './continuation-controller';
import type {ProgressPin} from './stopped-progress';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const same=(a:any,b:any)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&typeof b?.path==='string'&&path.resolve(a.path)===path.resolve(b.path);
function refuse():never{throw Object.assign(Error('EXACT_ACCEPTED_CHECKPOINT_RETRY_REQUIRED'),{code:'EXACT_ACCEPTED_CHECKPOINT_RETRY_REQUIRED'});}
export interface AcceptedCheckpointCarry {
 descriptor:ProgressPin;workId:string;caseId:string;retainedOriginalWorkId:string;receipt:any;journal:ProgressPin;originalAllocation:ProgressPin;
 followup:Readonly<{text:string;senderAgentId:string;recipientAgentId:string;caseId:string}>;
}
type Input={releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery};
/** Retains the old strict inspector intact: its input is the exact frozen ledger prefix. */
export async function inspectAcceptedCheckpointHistory<H extends {workId:string;caseId:string;actorId:string;priorWindow:string;priorExecution:ProgressPin;priorLedger:ProgressPin;metadataReceipts:ContinuationReceipt[];runtimePacket:any}>(input:Input,inspectOriginal:(input:Input)=>Promise<H>){
 const{recovery:r,ledger}=input;if(!r.acceptedCheckpoint)refuse();
 const d=(await readUnforwardedPin(r.acceptedCheckpoint)).value,p=(await readUnforwardedPin(d.packet)).value,e=(await readUnforwardedPin(d.execution)).value,stop=(await readUnforwardedPin(d.stop)).value,
  state=(await readUnforwardedPin(d.programState)).value,receipt=e.receipt as ContinuationReceipt,base=p.controlledRecoveryBase;
 if(d.purpose!=='actual-accepted-checkpoint-native-start-stop-inspection'||d.version!==1||d.executionAllowed!==false||d.newAuthorityGranted!==false
  ||d.sameAcceptedSendMustNotRepeat!==true||d.failedOriginalMustRemainFailed!==true||d.oldAdmissionMustNotReplay!==true
  ||d.window!==e.window||d.source!==receipt.clientSource||d.fixedHardStopUtc!==receipt.hardStopUtc
  ||e.purpose!=='actual-controlled-checkpoint-recovery'||e.window!==hash(JSON.stringify(receipt))||receipt.version!==1||receipt.ownerApproved!==true||receipt.modelCap!==64
  ||receipt.ciPassed!==true||receipt.ciHead!==receipt.clientSource||receipt.packetSha256!==d.packet.sha256||receipt.clientSource!==p.clientSource||receipt.serverSource!==p.serverSource||receipt.runnerSha256!==p.library?.sha256
  ||!Number.isFinite(Date.parse(receipt.startUtc))||Date.parse(receipt.hardStopUtc)-Date.parse(receipt.startUtc)!==5400000
  ||!Number.isFinite(Date.parse(e.actualStartedAtUtc))||e.actualStartedAtUtc!==receipt.startUtc||Date.parse(receipt.startUtc)>Date.now()
  ||path.resolve(p.oldKitRoot??'')!==path.resolve(input.releaseRoot)||p.purpose!=='phase-c-prepared-controlled-progress-session'
  ||!same(e.carriedState,r.state)||!same(e.carriedCheckpoint,r.carry)||p.carriedStateSha256!==r.state.sha256)refuse();
 const historicalKeys=['runtimePacket','initialExecution','execution','operatorSeal','state','stop','ledger','checkpoint','carry','pollGap','distinctFollowup'];
 if(historicalKeys.some(key=>!same(base?.[key],r[key as keyof ControlledProgressRecovery]))||!equal(base.startupStops??[],r.startupStops??[])||!base.operationAmendment?.allocation)refuse();
 const historicalPin=r.startupStops?.at(-1)?.ledger??r.ledger;
 await readUnforwardedPin(historicalPin,false);
 const historicalLedger=await ledger.inspectReadOnlyPrefix(historicalPin.path,historicalPin.sha256);
 const historical=await inspectOriginal({...input,ledger:historicalLedger,recovery:{...r,acceptedCheckpoint:undefined}});
 if(!same(e.priorExecution,historical.priorExecution)||!same(d.seal,{path:p.sealPath,sha256:e.sealSha256}))refuse();
 await readUnforwardedPin(d.seal);
 const wrapperFile=path.join(p.directory,'ADOPTION-RECORDED.private.json'),wrapperStat=await fs.lstat(wrapperFile);
 if(!wrapperStat.isFile()||wrapperStat.isSymbolicLink()||wrapperStat.size>16384)refuse();
 const wrapper=JSON.parse(await fs.readFile(wrapperFile,'utf8')),adoptionPin={path:p.decisionPaths?.adoption,sha256:receipt.approvalReceiptSha256};
 if(wrapper.purpose!=='actual-startup-source-time-decision-record-no-clock'||wrapper.clockStarted!==false||wrapper.sealSha256!==d.seal.sha256||wrapper.packetSha256!==d.packet.sha256||!same(wrapper.adoption,adoptionPin))refuse();
 const adoption=(await readUnforwardedPin(adoptionPin)).value;
 if(adoption.purpose!=='phase-c-explicit-controlled-progress-recovery'||adoption.owner!=='pjsk02'||adoption.ownerApproved!==true
  ||adoption.clientSource!==receipt.clientSource||adoption.serverSource!==receipt.serverSource||adoption.packetSha256!==d.packet.sha256||adoption.runnerSha256!==receipt.runnerSha256
  ||adoption.priorWindow!==historical.priorWindow||adoption.priorExecutionSha256!==historical.priorExecution.sha256||adoption.priorLedgerSha256!==historical.priorLedger.sha256
  ||adoption.modelCap!==64||adoption.operationCap!==62||adoption.normalOperationCap!==54||adoption.cleanupReserve!==8||adoption.currentModels!==ledger.snapshot().chargedAttempts||adoption.currentOperations!==33
  ||adoption.distinctFollowupSha256!==r.distinctFollowup?.sha256||adoption.operationAllocationSha256!==base.operationAmendment.allocation.sha256||adoption.preserveFailedOriginal!==true
  ||adoption.repeatOnboarding!==false||adoption.replayAcceptedSends!==false||adoption.repeatObservedControls!==false||adoption.timeMode!=='new-interval'||adoption.maximumIntervalMs!==5400000
  ||!Number.isFinite(Date.parse(adoption.receivedAtUtc))||Date.parse(adoption.receivedAtUtc)>Date.parse(receipt.startUtc))refuse();
 const readMarker=async(file:string)=>{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)refuse();return JSON.parse(await fs.readFile(file,'utf8'));};
 const admission=await readMarker(path.join(input.releaseRoot,'phase-c-controlled-progress-'+historical.priorWindow+'.used.json'));
 const time=await readMarker(path.join(input.releaseRoot,'phase-c-recovery-time-'+hash('pjsk02\0'+adoption.decisionId)+'.used.json'));
 if(admission.purpose!=='phase-c-one-use-controlled-progress'||admission.priorWindow!==historical.priorWindow||admission.nextWindow!==e.window||admission.stateSha256!==r.state.sha256||admission.ledgerSha256!==historical.priorLedger.sha256
  ||time.purpose!=='phase-c-one-use-controlled-progress-recovery'||time.approvalSha256!==receipt.approvalReceiptSha256||time.decisionId!==adoption.decisionId||time.priorWindow!==historical.priorWindow||time.window!==e.window)refuse();
 const current=await fs.readFile(ledger.filename),frozen=(await readUnforwardedPin(d.frozenRequests,false)).raw,prior=await historicalLedger.readInspectionBytes();
 if(!current.equals(frozen)||!current.subarray(0,prior.length).equals(prior)||!current.toString().endsWith('\n'))refuse();
 const tail=current.subarray(prior.length).toString().trimEnd().split('\n').map(line=>JSON.parse(line));
 if(tail.length!==2||tail[0].kind!=='window'||tail[1].kind!=='plan'||tail.some(row=>row.window!==e.window)
  ||tail[1].proof?.graphApprovalRaw!==e.graphApprovalRaw||hashReviewedContinuationPlan(p.reviewedGraph)!==ledger.reviewedPlan?.planSha256
  ||ledger.snapshot().chargedAttempts!==historicalLedger.snapshot().chargedAttempts||d.models!==ledger.snapshot().chargedAttempts||d.operations!==34||d.assets!==0
  ||ledger.snapshot().pending!==0||ledger.snapshot().unresolvedDispatches!==0)refuse();
 const actions=(await readUnforwardedPin(d.frozenActions,false)).raw;
 if(!actions.equals(await fs.readFile(path.join(input.releaseRoot,'phase-c-cumulative-actions.jsonl'))))refuse();
 const stoppedAt=Date.parse(stop.observedAtUtc),checked=Date.parse(d.checkedAtUtc);
 if(stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='remaining-native-program'||stop.gateComplete!==false||stop.packetSha256!==d.packet.sha256
  ||!Number.isFinite(stoppedAt)||stoppedAt<Date.parse(receipt.startUtc)||stoppedAt>Date.now()||!Number.isFinite(checked)||checked<stoppedAt||checked>Date.now())refuse();
 const accepted=d.acceptedReceipt,followup=(await readUnforwardedPin(r.distinctFollowup!)).value,personal=(await readUnforwardedPin(d.personalSend)).value;
 const ownerReceiptDigest=hash(JSON.stringify(canon(personal)));
 const workId=accepted?.messageId,caseId=historical.caseId,actor=p.actors.openclaw.agentId??p.actors.openclaw,sender=p.actors.testowner.agentId??p.actors.testowner;
 if(!/^msg_[A-Za-z0-9_-]+$/.test(workId)||workId===historical.workId||accepted.state!=='accepted'||accepted.caseId!==caseId||accepted.senderRole!=='testowner'
  ||accepted.ownerReceiptSha256!==ownerReceiptDigest||accepted.failedOriginalPreserved!==true||accepted.originalAcceptedSendRepeated!==false
  ||!equal(accepted,state.distinctFollowupReceipts?.openclaw)||state.observerFollowupAttempt?.state!=='accepted'||state.observerFollowupAttempt.requestId!==accepted.requestId
  ||state.observerFollowupAttempt.ownerReceiptSha256!==ownerReceiptDigest||personal.purpose!=='phase-c-personal-followup-confirmation'||personal.version!==1||personal.windowId!==e.window||personal.humanConfirmed!==true
  ||personal.requestId!==accepted.requestId||personal.subjectSha256!==state.observerFollowupAttempt.subjectSha256||Date.parse(personal.confirmedAtUtc)<Date.parse(receipt.startUtc)||Date.parse(personal.confirmedAtUtc)>stoppedAt
  ||followup.requestId!==accepted.requestId||followup.retainedFailedWorkId!==historical.workId||followup.caseId!==caseId||followup.senderAgentId!==sender||followup.recipientAgentId!==actor
  ||followup.additionalOperationReservations!==1||followup.requiresActualHumanSendConfirmation!==true||followup.failedWorkRequeued!==false||followup.acceptedSendRepeated!==false)refuse();
 const original=(await readUnforwardedPin(r.state)).value,old=state.retainedObserverFailedOriginal;
 if(state.phase!=='prepared'||state.window!==e.window||state.planSha256!==hash(JSON.stringify(canon({...p.program,windowId:e.window})))
  ||Object.keys(state.started??{}).join()!=='openclaw'||Object.keys(state.results??{}).length||Object.keys(state.effects??{}).length
  ||state.started.openclaw.workId!==workId||state.started.openclaw.caseId!==caseId||state.started.openclaw.beforeSha256!==accepted.canonicalSha256
  ||!equal(state.controlProofs,original.controlProofs)||!equal(state.carriedProgress,original.carriedProgress)||!equal(state.taskReceipts,original.taskReceipts)||!equal(state.carriedTaskReceipts,original.carriedTaskReceipts)
  ||old?.workId!==historical.workId||old.caseId!==caseId||old.canonicalStatus!=='failed'||old.attempts!==5||old.neverReplay!==true||old.journalSha256!==followup.retainedFailedJournalSha256)refuse();
 const controls=state.carriedControlObservations?.openclaw,poll=state.carriedOpenClawPollObservation;
 if(controls?.controlsRepeated!==false||controls.newSourceControlCredit!==false||!same(controls.descriptor,r.carry)
  ||poll?.workId!==historical.workId||poll.pollInterruptedAgain!==false||poll.newSourcePollCredit!==false||!same(poll.descriptor,r.carry))refuse();
 await readUnforwardedPin(old.journal,false);
 if(old.journal.sha256!==old.journalSha256)refuse();
 const selectionDirectory=path.join(p.directory,'native-program'),files=await fs.readdir(selectionDirectory);
 if(files.length>16||path.dirname(d.programState.path)!==selectionDirectory)refuse();
 let selected:any;for(const name of files){const file=path.join(selectionDirectory,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2000000)refuse();const bytes=await fs.readFile(file);if(hash(bytes)===accepted.canonicalSha256)selected=JSON.parse(bytes.toString());}
 const message=selected?.messages?.filter((m:any)=>m.id===workId&&m.caseId===caseId);
 if(selected?.case?.id!==caseId||!Array.isArray(message)||message.length!==1||message[0].text!==followup.text||message[0].senderAgentId!==sender||message[0].recipientAgentId!==actor)refuse();
 const canonical=(await readUnforwardedPin(d.canonicalStop)).value,works=canonical.work,sessions=canonical.sessions;
 const currentWork=Array.isArray(works)&&works.filter((w:any)=>w.workId===workId),priorWork=Array.isArray(works)&&works.filter((w:any)=>w.workId===historical.workId);
 if(canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||canonical.activeWorkLeases!==0||canonical.activeCaseSessions!==0||Date.parse(canonical.checkedAt)<stoppedAt
  ||!currentWork||currentWork.length!==1||!priorWork||priorWork.length!==1||currentWork[0].status!=='retryable'||currentWork[0].attempts!==1||currentWork[0].failure?.retryable!==true||currentWork[0].failure.reasonCode!=='HANDLER_FAILED'
  ||currentWork[0].messageStatus!=='acknowledged'||currentWork[0].processedAt!=null||priorWork[0].status!=='failed'||priorWork[0].attempts!==5||priorWork[0].failure?.retryable!==false
  ||priorWork[0].failure.reasonCode!=='HANDLER_FAILED'||!Array.isArray(sessions)||!sessions.some((s:any)=>s.workId===workId)||sessions.some((s:any)=>s.status!=='ended'))refuse();
 const journal=(await readUnforwardedPin(d.checkpointJournal)).value;
 if(path.resolve(d.checkpointJournal.path)!==path.resolve(p.states.openclaw,'scoped-runs',workId+'.json')||journal.version!==1||journal.workId!==workId||journal.completed!==false||journal.providerCalls!==1
  ||Object.keys(journal).sort().join()!=='completed,input,model,pending,providerCalls,version,workId'
  ||!Array.isArray(journal.pending)||journal.pending.length||typeof journal.model!=='string'||!journal.model.startsWith('openclaw:')||!Array.isArray(journal.input)||journal.input.length!==2
  ||journal.input[0].role!=='system'||journal.input[1].role!=='user'||journal.input.some((v:any)=>Object.keys(v).sort().join()!=='content,role'||typeof v.content!=='string'))refuse();
 const cleanup=(await readUnforwardedPin(d.cleanup)).value,accounting=(await readUnforwardedPin(d.accounting)).value;
 if(Date.parse(cleanup.checkedAtUtc)<stoppedAt||!Array.isArray(cleanup.ports)||cleanup.ports.length!==3||cleanup.ports.some((v:any)=>v.listening!==false)
  ||!Array.isArray(cleanup.hermes)||cleanup.hermes.length!==2||!['je1','testowner'].every(role=>cleanup.hermes.filter((v:any)=>v.role===role&&v.running===false).length===1)
  ||cleanup.modelsAdded!==0||cleanup.tasksSent!==0||accounting.window!==e.window||accounting.operations!==34||accounting.assets!==0||accounting.counts?.chargedAttempts!==d.models
  ||accounting.counts.pending!==0||accounting.counts.unresolvedDispatches!==0||accounting.counts.knownOpenClawDispatches!==0||accounting.retainedConfigUnchanged!==true||accounting.oldFailedJournalUnchanged!==true
  ||accounting.replayAttempted!==false||accounting.newLiveAdmission!==false||accounting.newWindow!==false)refuse();
 const carry:AcceptedCheckpointCarry={descriptor:r.acceptedCheckpoint,workId,caseId,retainedOriginalWorkId:historical.workId,receipt:accepted,journal:d.checkpointJournal,originalAllocation:base.operationAmendment.allocation,
  followup:{text:followup.text,senderAgentId:sender,recipientAgentId:actor,caseId}};
 return{...historical,workId,priorWindow:e.window,priorExecution:d.execution as ProgressPin,priorLedger:d.frozenRequests as ProgressPin,originalReceipt:receipt,currentLedgerSha256:hash(current),
  metadataReceipts:[...historical.metadataReceipts,receipt],acceptedCheckpoint:carry};
}
