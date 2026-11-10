// Carry one actually stopped persistent-workflow claim, with no physical dispatch.
// All history is read-only; this inspector grants no approval, claim or model use.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readUnforwardedPin} from './controlled-unforwarded';
import {hashReviewedContinuationPlan} from './continuation-plan';
import type {RequestBudgetLedger} from './request-budget';
import type {ControlledProgressRecovery} from './controlled-progress';
import type {ActiveContinuationReceipt,ContinuationWorkflowReceipt} from './continuation-controller';
import type {ProgressPin} from './stopped-progress';
import type {AcceptedCheckpointCarry} from './accepted-checkpoint-retry';

export const WORKFLOW_BOOTSTRAP_STOP_KIND='actual-accepted-checkpoint-workflow-bootstrap-stop';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const same=(a:any,b:any)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&typeof b?.path==='string'&&path.resolve(a.path)===path.resolve(b.path);
const dated=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function refuse():never{throw Object.assign(Error('EXACT_WORKFLOW_BOOTSTRAP_STOP_REQUIRED'),{code:'EXACT_WORKFLOW_BOOTSTRAP_STOP_REQUIRED'});}
async function marker(file:string){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)refuse();return JSON.parse(await fs.readFile(file,'utf8'));}
// The reviewed b853 private writer recorded the latest startup frame here. Its
// human adoption still names the immediate timeout parent, checked separately.
// Preserve that descriptive legacy field only when the approved packet and the
// already-inspected startup history agree with the pinned writer implementation.
export async function matchesRecordedWorkflowParent(input:{clientSource:unknown;recordedParent?:ProgressPin;priorExecution:ProgressPin;
 declaredStartupStops?:readonly {execution?:ProgressPin}[];inspectedStartupStops?:readonly {execution?:ProgressPin}[];core?:ProgressPin},
 readCore:(pin:ProgressPin)=>Promise<Buffer>=async pin=>(await readUnforwardedPin(pin,false)).raw){
 if(same(input.recordedParent,input.priorExecution))return true;
 const declared=input.declaredStartupStops?.at(-1)?.execution,inspected=input.inspectedStartupStops?.at(-1)?.execution;
 if(input.clientSource!=='b853393dc148b0919f085223b95fe3361236cd36'||!same(declared,inspected)||!same(input.recordedParent,inspected)
  ||!input.core||path.basename(input.core.path)!=='workflow-session.mjs')return false;
 const writer=await readCore(input.core);
 return writer.toString('utf8').includes('priorExecution:p.controlledRecoveryBase.startupStops.at(-1).execution');
}
type Input={releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery};
type Previous={workId:string;caseId:string;actorId:string;priorWindow:string;priorExecution:ProgressPin;priorLedger:ProgressPin;metadataReceipts:ActiveContinuationReceipt[];acceptedCheckpoint:AcceptedCheckpointCarry;originalReceipt:ActiveContinuationReceipt};

export async function inspectAcceptedWorkflowBootstrapStop<H extends Previous>(input:Input,inspectPrevious:(input:Input,journal:ProgressPin)=>Promise<H>){
 const {recovery:r,ledger}=input;if(!r.acceptedCheckpoint)refuse();
 const d=(await readUnforwardedPin(r.acceptedCheckpoint)).value;
 if(d.purpose!==WORKFLOW_BOOTSTRAP_STOP_KIND||d.version!==1||d.executionAllowed!==false||d.newAuthorityGranted!==false
  ||d.acceptedSendMustNotRepeat!==true||d.oldFailedTaskMustNotReplay!==true||d.oldAdmissionMustNotReplay!==true||d.noRecoveryAttempted!==true||d.missingCanonicalFields?.length!==0)refuse();
 const prior=(await readUnforwardedPin(d.priorAcceptedCheckpoint)).value;
 if(prior.purpose!=='actual-accepted-checkpoint-owner-target-timeout-stop'||!same(d.previousJournal,prior.checkpointJournal))refuse();
 const prefix=await ledger.inspectReadOnlyPrefix(prior.frozenRequests.path,prior.frozenRequests.sha256);
 const h=await inspectPrevious({...input,ledger:prefix,recovery:{...r,acceptedCheckpoint:d.priorAcceptedCheckpoint}},d.previousJournal);
 const attempts=h.acceptedCheckpoint.expectedAttempts+1;if(attempts!==4)refuse();
 const previous=(await readUnforwardedPin(d.previousJournal)).value,currentRaw=(await readUnforwardedPin(d.checkpointJournal)).raw,j=JSON.parse(currentRaw.toString());
 if(j.version!==1||j.workId!==h.workId||j.model!==previous.model||j.completed!==false||previous.completed!==false||previous.providerCalls!==2||j.providerCalls!==3
  ||!Array.isArray(previous.input)||previous.input.length!==3||!Array.isArray(j.input)||j.input.length!==4||!equal(j.input.slice(0,3),previous.input)
  ||!Array.isArray(j.pending)||j.pending.length||previous.pending?.length!==0||Object.keys(j).sort().join()!=='completed,input,model,pending,providerCalls,version,workId'
  ||j.input[3]?.role!=='user'||typeof j.input[3].content!=='string')refuse();
 const notice=JSON.parse(j.input[3].content);if(notice.notice!=='Fresh canonical state after host recovery; earlier history is context, not authority.'||!notice.context||!notice.snapshot)refuse();
 const p=(await readUnforwardedPin(d.packet)).value,e=(await readUnforwardedPin(d.execution)).value,receipt=e.receipt as ContinuationWorkflowReceipt,stop=(await readUnforwardedPin(d.stop)).value;
 if(p.purpose!=='phase-c-prepared-controlled-progress-session'||path.resolve(p.oldKitRoot??'')!==path.resolve(input.releaseRoot)||p.clientSource!==d.source||p.serverSource!==d.server
  ||receipt.version!==2||receipt.lifetime!=='until-complete-or-cancel'||receipt.humanReview!=='before-claim'||Object.hasOwn(receipt,'hardStopUtc')
  ||receipt.ownerApproved!==true||receipt.modelCap!==64||receipt.ciPassed!==true||receipt.ciHead!==receipt.clientSource||receipt.clientSource!==p.clientSource||receipt.serverSource!==p.serverSource
  ||receipt.runnerSha256!==p.library?.sha256||receipt.packetSha256!==d.packet.sha256||e.purpose!=='actual-controlled-checkpoint-recovery'||e.window!==hash(JSON.stringify(receipt))||d.window!==e.window
  ||!dated(receipt.startUtc)||Date.parse(receipt.startUtc)>Date.now()||e.actualStartedAtUtc!==receipt.startUtc||!await matchesRecordedWorkflowParent({clientSource:p.clientSource,recordedParent:e.priorExecution,priorExecution:h.priorExecution,declaredStartupStops:p.controlledRecoveryBase?.startupStops,inspectedStartupStops:r.startupStops,core:p.modules?.core})||!same(e.carriedState,r.state)||!same(e.carriedCheckpoint,r.carry)
  ||!equal(p.workflowPolicy,{lifetime:receipt.lifetime,humanReview:receipt.humanReview})||!same(p.controlledRecoveryBase?.acceptedCheckpoint,d.priorAcceptedCheckpoint))refuse();
 for(const key of ['runtimePacket','initialExecution','execution','operatorSeal','state','stop','ledger','checkpoint','carry','pollGap','distinctFollowup'])if(!same(p.controlledRecoveryBase[key],r[key as keyof ControlledProgressRecovery]))refuse();
 if(!equal(p.controlledRecoveryBase.startupStops??[],r.startupStops??[]))refuse();
 const seal=(await readUnforwardedPin(d.seal)).value;
 if(!same(seal.packet,d.packet)||e.sealSha256!==d.seal.sha256||path.resolve(p.sealPath??'')!==path.resolve(d.seal.path))refuse();
 const adoptionPin={path:p.decisionPaths?.adoption,sha256:receipt.approvalReceiptSha256},adoption=(await readUnforwardedPin(adoptionPin)).value,wrapper=await marker(path.join(p.directory,'ADOPTION-RECORDED.private.json'));
 if(wrapper.purpose!=='actual-direct-human-persistent-workflow-source-adoption'||wrapper.sealSha256!==d.seal.sha256||wrapper.packetSha256!==d.packet.sha256||!same(wrapper.adoption,adoptionPin)
  ||wrapper.workflowStarted!==false||wrapper.hostsStarted!==0||wrapper.modelCallsAdded!==0||wrapper.armCreated!==false)refuse();
 const trusted=(await readUnforwardedPin(wrapper.trusted)).value;
 if(trusted.owner!=='pjsk02'||trusted.trustedDirectHumanReply!==true||trusted.source!==p.clientSource||trusted.sealSha256!==d.seal.sha256||trusted.packetSha256!==d.packet.sha256||trusted.approvedPersistentWorkflow!==true
  ||!equal(trusted.workflowPolicy,p.workflowPolicy)||trusted.decisionId!==adoption.decisionId||trusted.receivedAtUtc!==adoption.receivedAtUtc)refuse();
 if(adoption.purpose!=='phase-c-explicit-controlled-progress-recovery'||adoption.owner!=='pjsk02'||adoption.ownerApproved!==true||adoption.clientSource!==p.clientSource||adoption.serverSource!==p.serverSource
  ||adoption.runnerSha256!==p.library.sha256||adoption.packetSha256!==d.packet.sha256||adoption.acceptedCheckpointSha256!==d.priorAcceptedCheckpoint.sha256||adoption.priorWindow!==h.priorWindow||adoption.priorExecutionSha256!==h.priorExecution.sha256||adoption.priorLedgerSha256!==h.priorLedger.sha256
  ||adoption.modelCap!==64||adoption.operationCap!==62||adoption.normalOperationCap!==54||adoption.cleanupReserve!==8||adoption.currentModels!==35||adoption.currentOperations!==34||adoption.currentCanonicalMessages!==14
  ||adoption.preserveFailedOriginal!==true||adoption.repeatOnboarding!==false||adoption.replayAcceptedSends!==false||adoption.repeatObservedControls!==false||adoption.timeMode!==receipt.lifetime||adoption.lifetime!==receipt.lifetime||adoption.humanReview!==receipt.humanReview
  ||Object.hasOwn(adoption,'maximumIntervalMs')||!dated(adoption.receivedAtUtc)||Date.parse(adoption.receivedAtUtc)>Date.parse(receipt.startUtc)||typeof adoption.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(adoption.decisionId))refuse();
 const admission=await marker(path.join(input.releaseRoot,'phase-c-controlled-progress-'+h.priorWindow+'.used.json')),decision=await marker(path.join(input.releaseRoot,'phase-c-recovery-time-'+hash('pjsk02\0'+adoption.decisionId)+'.used.json'));
 if(admission.purpose!=='phase-c-one-use-controlled-progress'||admission.priorWindow!==h.priorWindow||admission.nextWindow!==e.window||admission.stateSha256!==r.state.sha256||admission.ledgerSha256!==h.priorLedger.sha256
  ||decision.purpose!=='phase-c-one-use-controlled-progress-recovery'||decision.approvalSha256!==receipt.approvalReceiptSha256||decision.decisionId!==adoption.decisionId||decision.priorWindow!==h.priorWindow||decision.window!==e.window||decision.timeMode!==receipt.lifetime)refuse();
 const rows=await ledger.readInspectionBytes(),frozen=(await readUnforwardedPin(d.frozenRequests,false)).raw,oldRows=await prefix.readInspectionBytes();
 if(!rows.equals(frozen)||!rows.subarray(0,oldRows.length).equals(oldRows)||!rows.toString().endsWith('\n'))refuse();
 const tail=rows.subarray(oldRows.length).toString().trimEnd().split('\n').map(x=>JSON.parse(x));
 if(tail.length!==2||tail[0].kind!=='window'||tail[1].kind!=='plan'||tail.some(x=>x.window!==e.window)||tail[1].proof?.graphApprovalRaw!==e.graphApprovalRaw||hashReviewedContinuationPlan(p.reviewedGraph)!==ledger.reviewedPlan?.planSha256
  ||ledger.snapshot().chargedAttempts!==35||prefix.snapshot().chargedAttempts!==35||ledger.snapshot().pending!==0||ledger.snapshot().unresolvedDispatches!==0||d.models!==35||d.physicalOpenClawAdded!==0||d.operations!==34||d.results!==0||d.effects!==0)refuse();
 const actions=(await readUnforwardedPin(d.frozenActions,false)).raw;if(d.frozenActions.sha256!==prior.frozenActions.sha256||!actions.equals(await fs.readFile(path.join(input.releaseRoot,'phase-c-cumulative-actions.jsonl'))))refuse();
 const ended=Date.parse(stop.observedAtUtc),now=Date.now();
 if(stop.state!=='controlled_recovery_stopped_preserve_originals'||stop.phase!=='remaining-native-program'||stop.gateComplete!==false||stop.packetSha256!==d.packet.sha256||!Number.isFinite(ended)||ended<Date.parse(receipt.startUtc)||ended>now||!dated(d.checkedAtUtc)||Date.parse(d.checkedAtUtc)<ended||Date.parse(d.checkedAtUtc)>now)refuse();
 const failure=(await readUnforwardedPin(d.failure,false)).raw.toString();if(!/\bOWNED_NATIVE_BOOTSTRAP_TIMEOUT\b/.test(failure)||d.reasonCode!=='OWNED_NATIVE_BOOTSTRAP_TIMEOUT')refuse();
 const state=(await readUnforwardedPin(d.programState)).value,previousState=(await readUnforwardedPin(prior.programState)).value;
 if(state.phase!=='prepared'||state.window!==e.window||state.planSha256!==hash(JSON.stringify(canon({...p.program,windowId:e.window})))||Object.keys(state.started??{}).join()!=='openclaw'||Object.keys(state.results??{}).length||Object.keys(state.effects??{}).length||state.started.openclaw.workId!==h.workId||state.started.openclaw.caseId!==h.caseId
  ||path.resolve(d.canonicalCheckpointJournalPath)!==path.resolve(p.states.openclaw,'scoped-runs',h.workId+'.json')||!currentRaw.equals(await fs.readFile(d.canonicalCheckpointJournalPath)))refuse();
 for(const key of ['controlProofs','taskReceipts','carriedProgress','carriedTaskReceipts','retainedObserverFailedOriginal','distinctFollowupReceipts','carriedControlObservations','carriedOpenClawPollObservation'])if(!equal(state[key],previousState[key]))refuse();
 const eventsRaw=(await readUnforwardedPin(d.events,false)).raw;if(!eventsRaw.toString().endsWith('\n'))refuse();
 const events=eventsRaw.toString().trimEnd().split('\n').map(x=>JSON.parse(x)),kinds=['actual_session_started_awaiting_personal_gateway_addresses','owned_native_factory_ready','existing_receiver_ready','prior_openclaw_controls_carried_without_repetition','prior_openclaw_poll_gap_carried_without_repetition','actual_canonical_context','actual_bounded_case_snapshot','receiver_startup_transport_failure','receiver_startup_transport_failure','canonical_settlement'];
 if(events.length!==kinds.length||events.some((x,i)=>x.kind!==kinds[i]||x.window!==e.window||!dated(x.atUtc)||Date.parse(x.atUtc)<Date.parse(e.actualStartedAtUtc)||Date.parse(x.atUtc)>ended))refuse();
 const context=events[5],snapshot=events[6],settlement=events[9];
 if(events[0].modelCalls!==35||events[0].onboardingRepeated!==false||events[0].acceptedSendsRepeated!==false||events[1].nativeGatewayStarted!==false||events[1].modelPromptsSubmitted!==0||context.flowId!=='openclaw'||context.role!=='openclaw'||context.workId!==h.workId||context.caseId!==h.caseId||context.session?.agentId!==h.actorId||context.session.installationId!==p.actors.openclaw.installationId||context.session.workId!==h.workId||context.session.caseId!==h.caseId||!Number.isSafeInteger(context.session.fence)||context.session.fence<1
  ||!dated(context.session.createdAt)||snapshot.workId!==h.workId||snapshot.caseId!==h.caseId||typeof snapshot.rawSnapshotBytes!=='string'||hash(snapshot.rawSnapshotBytes)!==snapshot.sha256||settlement.role!=='openclaw'||settlement.workId!==h.workId||settlement.status!=='retryable'||settlement.operation!=='fail')refuse();
 const visible=notice.context,expectedVisibleKeys=['agentAddress','allowedTools','counterpartyKind','sessionExpiresInSeconds',...(context.session.counterparty?.kind==='agent'?['counterpartyAddress']:[])];
 if(!equal(notice.snapshot,JSON.parse(snapshot.rawSnapshotBytes))||Object.keys(visible).sort().join()!==expectedVisibleKeys.sort().join()||visible.agentAddress!==p.actors.openclaw.address
  ||visible.counterpartyKind!==context.session.counterparty?.kind||visible.counterpartyAddress!==context.session.counterparty?.address||!equal(visible.allowedTools,context.session.allowedTools)
  ||!Number.isSafeInteger(visible.sessionExpiresInSeconds)||visible.sessionExpiresInSeconds<0||visible.sessionExpiresInSeconds>900)refuse();
 const request=(await readUnforwardedPin(d.personalTargetRequest)).value,response=(await readUnforwardedPin(d.personalTargetResponse)).value,t=request.targets?.[0];
 if(request.purpose!=='phase-c-personal-preclaim-native-selection-request'||request.version!==1||request.lifetime!=='one-claim-until-cancel'||Object.hasOwn(request,'hardStopUtc')||request.window!==e.window||request.clientSource!==p.clientSource||request.targets?.length!==1||t.workId!==h.workId||t.caseId!==h.caseId||t.agentId!==h.actorId||t.installationId!==p.actors.openclaw.installationId||t.nativeSourceSha256!==p.nativeBoundary.nativeSourceSha256
  ||response.purpose!=='phase-c-personal-preclaim-native-selection-response'||response.window!==e.window||response.requestSha256!==hash(JSON.stringify(request))||response.state!=='confirmed'||response.decisions?.length!==1||response.decisions[0].workId!==h.workId||path.resolve(request.receiptPath)!==path.resolve(d.personalTargetResponse.path))refuse();
 const answer=JSON.parse(response.decisions[0].rawDecision),exact={purpose:'phase-c-personal-preclaim-native-selection',version:1,ownerApproved:true,lifetime:'one-claim-until-cancel',subjectHash:t.subjectHash,window:e.window,clientSource:p.clientSource,nativeSourceSha256:p.nativeBoundary.nativeSourceSha256};
 if(Object.keys(answer).sort().join()!==[...Object.keys(exact),'approvedAtUtc'].sort().join()||Object.entries(exact).some(([k,v])=>answer[k]!==v)||!dated(answer.approvedAtUtc)||Date.parse(answer.approvedAtUtc)<Date.parse(receipt.startUtc)||Date.parse(answer.approvedAtUtc)>Date.parse(context.session.createdAt))refuse();
 const q=(await readUnforwardedPin(d.canonicalFreshOwnerRead)).value,w=q.work?.filter((x:any)=>x.workId===h.workId),original=q.work?.filter((x:any)=>x.workId===h.acceptedCheckpoint.retainedOriginalWorkId);
 if(q.database!=='sinaloa_staging'||q.readOnly!=='on'||!dated(q.checkedAt)||Date.parse(q.checkedAt)<ended||Date.parse(q.checkedAt)>now||q.activeWorkLeases!==0||q.activeCaseSessions!==0||q.caseState!=='inProgress'||w?.length!==1||w[0].status!=='retryable'||w[0].attempts!==attempts||w[0].failure?.retryable!==true||w[0].failure.reasonCode!=='HANDLER_FAILED'||w[0].messageStatus!=='acknowledged'||w[0].processedAt!=null||original?.length!==1||original[0].status!=='failed'||original[0].attempts!==5||original[0].failure?.retryable!==false||original[0].failure.reasonCode!=='HANDLER_FAILED'
  ||!Array.isArray(q.sessions)||!q.sessions.some((s:any)=>s.workId===h.workId&&s.id===context.session.id&&s.fence===context.session.fence)||q.sessions.some((s:any)=>s.status!=='ended'))refuse();
 const ports=(await readUnforwardedPin(d.physicalPorts)).value,processes=(await readUnforwardedPin(d.physicalProcesses)).value;
 if(!dated(ports.checkedAtUtc)||Date.parse(ports.checkedAtUtc)<ended||Date.parse(ports.checkedAtUtc)>now||ports.ports?.length!==2||new Set(ports.ports.map((x:any)=>x.origin)).size!==2||ports.ports.some((x:any)=>{try{const u=new URL(x.origin);return u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.origin!==x.origin||x.listening!==false;}catch{return true;}})||!ports.ports.some((x:any)=>x.origin===t.gatewayOrigin)||ports.modelsAdded!==0||ports.processesSignaled!==0
  ||!dated(processes.checkedAtUtc)||Date.parse(processes.checkedAtUtc)<ended||Date.parse(processes.checkedAtUtc)>now||processes.nativeCandidates?.length!==0||processes.gatewayListeners?.length!==0||processes.originalWorkerGone!==true||processes.nativeProcessesGone!==true||processes.gatewayNotListening!==true||processes.modelsAdded!==0||processes.processesSignaled!==0||processes.cleanupFailureRetained!==true)refuse();
 return {...h,priorWindow:e.window,priorExecution:d.execution as ProgressPin,priorLedger:d.frozenRequests as ProgressPin,originalReceipt:receipt,currentLedgerSha256:hash(rows),metadataReceipts:[...h.metadataReceipts,receipt],acceptedCheckpoint:{...h.acceptedCheckpoint,descriptor:r.acceptedCheckpoint,journal:d.checkpointJournal,expectedAttempts:attempts}};
}
