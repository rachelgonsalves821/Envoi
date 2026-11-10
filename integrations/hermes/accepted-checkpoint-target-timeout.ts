// Read-only carry of an expired personal target review. This never approves the
// expired target, retries an admission, edits a journal or grants a new clock.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readUnforwardedPin} from './controlled-unforwarded';
import {hashReviewedContinuationPlan} from './continuation-plan';
import type {RequestBudgetLedger} from './request-budget';
import type {ControlledProgressRecovery} from './controlled-progress';
import type {ContinuationReceipt} from './continuation-controller';
import type {ProgressPin} from './stopped-progress';
import type {AcceptedCheckpointCarry} from './accepted-checkpoint-retry';

export const OWNER_TARGET_TIMEOUT_KIND='actual-accepted-checkpoint-owner-target-timeout-stop';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const dated=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const same=(a:any,b:any)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&typeof b?.path==='string'&&path.resolve(a.path)===path.resolve(b.path);
const ownedOrigin=(v:unknown)=>{try{const u=new URL(String(v));return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!!u.port&&u.origin===v;}catch{return false;}};
function refuse():never {throw Object.assign(Error('EXACT_OWNER_TARGET_TIMEOUT_STOP_REQUIRED'),{code:'EXACT_OWNER_TARGET_TIMEOUT_STOP_REQUIRED'});}
async function absent(file:string){try{await fs.lstat(file);refuse();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
async function marker(file:string){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)refuse();return JSON.parse(await fs.readFile(file,'utf8'));}
type Input={releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery};
type Previous={workId:string;caseId:string;actorId:string;priorWindow:string;priorExecution:ProgressPin;priorLedger:ProgressPin;metadataReceipts:ContinuationReceipt[];acceptedCheckpoint:AcceptedCheckpointCarry;originalReceipt:ContinuationReceipt};

export async function inspectAcceptedTargetTimeout<H extends Previous>(input:Input,inspectPrevious:(input:Input)=>Promise<H>){
 const {recovery:r,ledger}=input;if(!r.acceptedCheckpoint)refuse();
 const d=(await readUnforwardedPin(r.acceptedCheckpoint)).value;
 if(d.purpose!==OWNER_TARGET_TIMEOUT_KIND||d.version!==1||d.executionAllowed!==false||d.newAuthorityGranted!==false||d.personalTargetResponseAbsent!==true||d.ownerReviewCompleted!==false||d.checkpointJournalUnchanged!==true||d.acceptedSendMustNotRepeat!==true||d.oldFailedTaskMustNotReplay!==true||d.oldTargetDeadlineMustNotMove!==true||d.noRecoveryAttempted!==true||!d.canonicalFreshOwnerRead||d.missingCanonicalFields?.length!==0)refuse();
 const prior=(await readUnforwardedPin(d.priorAcceptedCheckpoint)).value;
 if(!['actual-v3-post-target-pre-model-stop-inspection',OWNER_TARGET_TIMEOUT_KIND].includes(prior.purpose)||d.checkpointJournal?.sha256!==prior.checkpointJournal?.sha256)refuse();
 const prefix=await ledger.inspectReadOnlyPrefix(prior.frozenRequests.path,prior.frozenRequests.sha256);
 const h=await inspectPrevious({...input,ledger:prefix,recovery:{...r,acceptedCheckpoint:d.priorAcceptedCheckpoint}});
 // The service's retryable attempts and the journal's logical provider counter
 // are separate. This path adds exactly one settled claim and no journal turn.
 const attempts=h.acceptedCheckpoint.expectedAttempts+1;
 if(attempts<3||attempts>4)refuse();
 const journal=(await readUnforwardedPin(d.checkpointJournal)).raw,j=JSON.parse(journal.toString());
 const previousJournal=(await readUnforwardedPin(prior.checkpointJournal)).raw;
 if(!journal.equals(previousJournal)||j.version!==1||j.workId!==h.workId||j.completed!==false||j.providerCalls!==2||j.input?.length!==3||!Array.isArray(j.pending)||j.pending.length||d.providerCalls!==2||d.inputCount!==3||!journal.equals(await fs.readFile(d.canonicalCheckpointJournalPath)))refuse();
 const p=(await readUnforwardedPin(d.packet)).value,e=(await readUnforwardedPin(d.execution)).value,receipt=e.receipt as ContinuationReceipt,stop=(await readUnforwardedPin(d.stop)).value;
 if(p.purpose!=='phase-c-prepared-controlled-progress-session'||path.resolve(p.oldKitRoot??'')!==path.resolve(input.releaseRoot)||p.clientSource!==d.source||p.serverSource!==d.server||p.program?.clientSource!==p.clientSource||p.program?.serverSource!==p.serverSource||p.clientSource!==receipt.clientSource||p.serverSource!==receipt.serverSource||p.library?.sha256!==receipt.runnerSha256||receipt.version!==1||receipt.ownerApproved!==true||receipt.modelCap!==64||receipt.ciPassed!==true||receipt.ciHead!==receipt.clientSource||receipt.packetSha256!==d.packet.sha256||e.window!==hash(JSON.stringify(receipt))||d.window!==e.window||d.fixedHardStopUtc!==receipt.hardStopUtc||!dated(receipt.startUtc)||!dated(receipt.hardStopUtc)||Date.parse(receipt.hardStopUtc)-Date.parse(receipt.startUtc)!==5400000||!dated(e.actualStartedAtUtc)||Date.parse(e.actualStartedAtUtc)<Date.parse(receipt.startUtc)||!same(e.priorExecution,h.priorExecution)||!same(e.carriedState,r.state)||!same(e.carriedCheckpoint,r.carry))refuse();
 const seal=(await readUnforwardedPin(d.seal)).value;
 if(!same(seal.packet,d.packet)||e.sealSha256!==d.seal.sha256||path.resolve(p.sealPath??'')!==path.resolve(d.seal.path))refuse();
 if(!same(p.controlledRecoveryBase?.acceptedCheckpoint,d.priorAcceptedCheckpoint)||!equal(p.controlledRecoveryBase.startupStops??[],r.startupStops??[]))refuse();
 for(const key of ['runtimePacket','initialExecution','execution','operatorSeal','state','stop','ledger','checkpoint','carry','pollGap','distinctFollowup'])if(!same(p.controlledRecoveryBase[key],r[key as keyof ControlledProgressRecovery]))refuse();
 const adoption=(await readUnforwardedPin({path:p.decisionPaths?.adoption,sha256:receipt.approvalReceiptSha256})).value;
 if(adoption.purpose!=='phase-c-explicit-controlled-progress-recovery'||adoption.owner!=='pjsk02'||adoption.ownerApproved!==true||adoption.clientSource!==p.clientSource||adoption.serverSource!==p.serverSource||adoption.runnerSha256!==p.library.sha256||adoption.packetSha256!==d.packet.sha256||adoption.acceptedCheckpointSha256!==d.priorAcceptedCheckpoint.sha256||adoption.priorWindow!==h.priorWindow||adoption.priorExecutionSha256!==h.priorExecution.sha256||adoption.priorLedgerSha256!==h.priorLedger.sha256||adoption.modelCap!==64||adoption.operationCap!==62||adoption.normalOperationCap!==54||adoption.cleanupReserve!==8||adoption.currentModels!==35||adoption.currentOperations!==34||adoption.currentCanonicalMessages!==14||adoption.preserveFailedOriginal!==true||adoption.repeatOnboarding!==false||adoption.replayAcceptedSends!==false||adoption.repeatObservedControls!==false||!['same-fixed','new-interval'].includes(adoption.timeMode)||adoption.maximumIntervalMs!==5400000||!dated(adoption.receivedAtUtc)||Date.parse(adoption.receivedAtUtc)>Date.parse(e.actualStartedAtUtc)||typeof adoption.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(adoption.decisionId))refuse();
 if(adoption.timeMode==='same-fixed'&&(receipt.startUtc!==h.originalReceipt.startUtc||receipt.hardStopUtc!==h.originalReceipt.hardStopUtc)||adoption.timeMode==='new-interval'&&(Date.parse(adoption.receivedAtUtc)>Date.parse(receipt.startUtc)||Date.parse(receipt.startUtc)<Date.parse(h.originalReceipt.startUtc)))refuse();
 const admission=await marker(path.join(input.releaseRoot,'phase-c-controlled-progress-'+h.priorWindow+'.used.json')),time=await marker(path.join(input.releaseRoot,'phase-c-recovery-time-'+hash('pjsk02\0'+adoption.decisionId)+'.used.json'));
 if(admission.purpose!=='phase-c-one-use-controlled-progress'||admission.priorWindow!==h.priorWindow||admission.nextWindow!==e.window||admission.stateSha256!==r.state.sha256||admission.ledgerSha256!==h.priorLedger.sha256||time.purpose!=='phase-c-one-use-controlled-progress-recovery'||time.approvalSha256!==receipt.approvalReceiptSha256||time.decisionId!==adoption.decisionId||time.priorWindow!==h.priorWindow||time.window!==e.window)refuse();
 const current=await ledger.readInspectionBytes(),frozen=(await readUnforwardedPin(d.frozenRequests,false)).raw,old=await prefix.readInspectionBytes();
 if(!current.equals(frozen)||!current.subarray(0,old.length).equals(old)||!current.toString().endsWith('\n'))refuse();
 const tail=current.subarray(old.length).toString().trimEnd().split('\n').map(x=>JSON.parse(x));
 if(tail.length!==2||tail[0].kind!=='window'||tail[1].kind!=='plan'||tail.some(x=>x.window!==e.window)||tail[1].proof?.graphApprovalRaw!==e.graphApprovalRaw||hashReviewedContinuationPlan(p.reviewedGraph)!==ledger.reviewedPlan?.planSha256||ledger.snapshot().chargedAttempts!==35||prefix.snapshot().chargedAttempts!==35||ledger.snapshot().pending!==0||ledger.snapshot().unresolvedDispatches!==0||d.models!==35||d.physicalOpenClawAdded!==0||d.operations!==34||d.assets!==0||d.results!==0||d.effects!==0)refuse();
 const actions=(await readUnforwardedPin(d.frozenActions,false)).raw;
 if(d.frozenActions.sha256!==prior.frozenActions.sha256||!actions.equals(await fs.readFile(path.join(input.releaseRoot,'phase-c-cumulative-actions.jsonl'))))refuse();
 const ended=Date.parse(stop.observedAtUtc),deadline=Date.parse(d.targetDeadlineUtc),now=Date.now();
 if(!dated(d.checkedAtUtc)||!Number.isFinite(ended)||!Number.isFinite(deadline)||stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='remaining-native-program'||stop.gateComplete!==false||stop.packetSha256!==d.packet.sha256||ended<deadline||deadline<Date.parse(e.actualStartedAtUtc)||ended>now||Date.parse(d.checkedAtUtc)<ended||Date.parse(d.checkedAtUtc)>now||ended>=Date.parse(receipt.hardStopUtc))refuse();
 const failure=(await readUnforwardedPin(d.failure,false)).raw.toString();
 if(!failure.startsWith('DOMException [TimeoutError]: The operation was aborted due to timeout'))refuse();
 const request=(await readUnforwardedPin(d.personalTargetRequest)).value;
 if(request.purpose!=='phase-c-personal-native-target-batch'||request.version!==1||request.window!==e.window||request.clientSource!==p.clientSource||request.hardStopUtc!==d.targetDeadlineUtc||deadline>Date.parse(receipt.hardStopUtc)||request.targets?.length!==1||request.targets[0].workId!==h.workId||request.targets[0].hardStopUtc!==request.hardStopUtc||typeof request.receiptPath!=='string'||path.dirname(path.resolve(request.receiptPath))!==path.resolve(p.directory,'owner-requests')||!/^native-[a-f0-9]{64}\.owner\.json$/.test(path.basename(request.receiptPath)))refuse();
 for(const [key,purpose] of [['targetDecisionTemplate','phase-c-personal-native-target-selection'],['capabilityDecisionTemplate','closed-openclaw-core-anthropic-capability']]){const t=request.targets[0][key];if(t?.version!==1||t.purpose!==purpose||t.ownerApproved!==false||t.window!==e.window||t.clientSource!==p.clientSource||t.nativeSourceSha256!==p.nativeBoundary?.nativeSourceSha256||!/^[a-f0-9]{64}$/.test(t.subjectHash)||t.expiresAtUtc!==request.hardStopUtc)refuse();}
 await absent(request.receiptPath);
 const state=(await readUnforwardedPin(d.programState)).value,previousState=(await readUnforwardedPin(prior.programState)).value;
 if(state.phase!=='prepared'||state.window!==e.window||state.planSha256!==hash(JSON.stringify(canon({...p.program,windowId:e.window})))||Object.keys(state.started??{}).join()!=='openclaw'||Object.keys(state.results??{}).length||Object.keys(state.effects??{}).length||state.started.openclaw.workId!==h.workId||state.started.openclaw.caseId!==h.caseId||path.resolve(d.canonicalCheckpointJournalPath)!==path.resolve(p.states.openclaw,'scoped-runs',h.workId+'.json'))refuse();
 for(const key of ['controlProofs','taskReceipts','carriedProgress','carriedTaskReceipts','retainedObserverFailedOriginal','distinctFollowupReceipts','carriedControlObservations','carriedOpenClawPollObservation'])if(!equal(state[key],previousState[key]))refuse();
 const eventsRaw=(await readUnforwardedPin(d.events,false)).raw;
 if(!eventsRaw.toString().endsWith('\n'))refuse();
 const events=eventsRaw.toString().trimEnd().split('\n').map(x=>JSON.parse(x)),kinds=['actual_session_started_awaiting_personal_gateway_addresses','owned_native_factory_ready','existing_receiver_ready','prior_openclaw_controls_carried_without_repetition','prior_openclaw_poll_gap_carried_without_repetition','actual_canonical_context','actual_bounded_case_snapshot','receiver_startup_transport_failure','canonical_settlement'];
 if(events.length!==kinds.length||events.some((v,i)=>v.kind!==kinds[i]||v.window!==e.window||!dated(v.atUtc)||Date.parse(v.atUtc)<Date.parse(e.actualStartedAtUtc)||Date.parse(v.atUtc)>ended))refuse();
 const context=events[5],snapshot=events[6],settlement=events[8];
 if(events[0].modelCalls!==35||events[0].onboardingRepeated!==false||events[0].acceptedSendsRepeated!==false||events[1].nativeGatewayStarted!==false||events[1].modelPromptsSubmitted!==0||context.flowId!=='openclaw'||context.role!=='openclaw'||context.workId!==h.workId||context.caseId!==h.caseId||context.session?.agentId!==h.actorId||context.session.installationId!==p.actors.openclaw.installationId||!context.session.id||!Number.isSafeInteger(context.session.fence)||context.session.fence<1||snapshot.workId!==h.workId||snapshot.caseId!==h.caseId||typeof snapshot.rawSnapshotBytes!=='string'||hash(snapshot.rawSnapshotBytes)!==snapshot.sha256||settlement.role!=='openclaw'||settlement.workId!==h.workId||settlement.status!=='retryable'||settlement.operation!=='fail'||!equal(d.canonicalSettlementAcknowledgement,settlement))refuse();
 const q=(await readUnforwardedPin(d.canonicalFreshOwnerRead)).value,w=q.work?.filter((x:any)=>x.workId===h.workId),original=q.work?.filter((x:any)=>x.workId===h.acceptedCheckpoint.retainedOriginalWorkId);
 if(q.database!=='sinaloa_staging'||q.readOnly!=='on'||!dated(q.checkedAt)||Date.parse(q.checkedAt)<ended||Date.parse(q.checkedAt)>now||q.activeWorkLeases!==0||q.activeCaseSessions!==0||q.caseState!=='inProgress'||w?.length!==1||w[0].status!=='retryable'||w[0].attempts!==attempts||w[0].failure?.retryable!==true||w[0].failure.reasonCode!=='HANDLER_FAILED'||w[0].messageStatus!=='acknowledged'||w[0].processedAt!=null||original?.length!==1||original[0].status!=='failed'||original[0].attempts!==5||original[0].failure?.retryable!==false||original[0].failure.reasonCode!=='HANDLER_FAILED'||!Array.isArray(q.sessions)||!q.sessions.some((s:any)=>s.workId===h.workId&&s.id===context.session.id&&s.fence===context.session.fence)||q.sessions.some((s:any)=>s.status!=='ended'))refuse();
 const ports=(await readUnforwardedPin(d.physicalPorts)).value,processes=(await readUnforwardedPin(d.physicalProcesses)).value;
 if(!dated(ports.checkedAtUtc)||!dated(processes.checkedAtUtc)||Date.parse(ports.checkedAtUtc)<ended||Date.parse(ports.checkedAtUtc)>now||ports.ports?.length!==2||ports.ports.some((x:any)=>!ownedOrigin(x.origin)||x.listening!==false||x.state!=='ECONNREFUSED')||new Set(ports.ports.map((x:any)=>x.origin)).size!==2||!ports.ports.some((x:any)=>x.origin===request.targets[0].safeDisplay?.gatewayOrigin)||ports.processesSignaled!==0||ports.modelsAdded!==0||Date.parse(processes.checkedAtUtc)<ended||Date.parse(processes.checkedAtUtc)>now||processes.nativeChildCount!==0||processes.originalOperatorGone!==true||processes.processesSignaled!==0||processes.modelsAdded!==0)refuse();
 return {...h,priorWindow:e.window,priorExecution:d.execution as ProgressPin,priorLedger:d.frozenRequests as ProgressPin,originalReceipt:receipt,currentLedgerSha256:hash(current),metadataReceipts:[...h.metadataReceipts,receipt],acceptedCheckpoint:{...h.acceptedCheckpoint,descriptor:r.acceptedCheckpoint,journal:d.checkpointJournal,expectedAttempts:attempts}};
}
