// Recovery after actual controls, before the first native target/admission.
// Historical results are pinned, never recreated or promoted to native success.
import fs from'node:fs/promises';import path from'node:path';import{createHash}from'node:crypto';
import type{ContinuationReceipt}from'./continuation-controller';
import{inspectStoppedProgress,inspectStoppedProgressHistory,type ProgressPin,type StoppedProgressRecovery,type StoppedProgressPreflight}from'./stopped-progress';
import type{RequestBudgetLedger}from'./request-budget';import{hashReviewedContinuationPlan}from'./continuation-plan';
export type ControlledProgressRecovery=Readonly<{
  history:StoppedProgressRecovery;runtimePacket:ProgressPin;initialExecution:ProgressPin;execution:ProgressPin;operatorSeal:ProgressPin;
  state:ProgressPin;stop:ProgressPin;ledger:ProgressPin;checkpoint:ProgressPin;carry:ProgressPin;pollGap:ProgressPin;canonicalWork:ProgressPin;adoption:ProgressPin;targetPacket:ProgressPin;
}>;
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v),canon=(v:any):any=>Array.isArray(v)?v.map(canon):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
function refuse(code:string):never{throw Object.assign(Error(code),{code});}
async function read(p:ProgressPin,parse=true){if(!p||!path.isAbsolute(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256))refuse('EXACT_CONTROLLED_PROGRESS_PIN_REQUIRED');const stat=await fs.lstat(p.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2000000)refuse('BOUNDED_CONTROLLED_PROGRESS_PIN_REQUIRED');const raw=await fs.readFile(p.path);if(hash(raw)!==p.sha256)refuse('CONTROLLED_PROGRESS_CHANGED');return{raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};}
function originalReceipt(e:any){const r=e?.receipt,start=Date.parse(r?.startUtc),end=Date.parse(r?.hardStopUtc);if(!object(r)||r.version!==1||r.ownerApproved!==true||r.modelCap!==64||r.ciPassed!==true||r.ciHead!==r.clientSource||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>5400000||e.window!==hash(JSON.stringify(r)))refuse('GENUINE_CONTROLLED_EXECUTION_REQUIRED');return r as ContinuationReceipt;}
export async function inspectControlledProgressHistory(input:{releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery}){
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
 const historical=await inspectStoppedProgressHistory({releaseRoot:input.releaseRoot,recovery:r.history,ledger,nextStart:Date.parse(a.startUtc)},[a,b]);
 const rows=(await read(r.ledger,false)).raw;if(!rows.equals(await fs.readFile(ledger.filename))||hash(rows)!==ledger.contentSha256)refuse('CONTROLLED_LEDGER_CHANGED');
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
 const filename=path.join(p.states.openclaw,'scoped-runs',work.workId+'.json');try{await fs.lstat(filename);refuse('NATIVE_JOURNAL_MUST_BE_ABSENT');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
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
 return{...historical,originalReceipt:b,priorWindow:current.window,currentLedgerSha256:hash(rows),stateSha256:r.state.sha256,workId:work.workId,caseId:work.caseId,
   actorId:p.actors.openclaw.agentId,carriedControlProofs:controls,carriedControlSource:b.clientSource,pollGapSha256:r.pollGap.sha256,runtimePacket:p,initialReceipt:a};
}
export async function inspectControlledProgress(input:{releaseRoot:string;ledger:RequestBudgetLedger;recovery:ControlledProgressRecovery;receipt:ContinuationReceipt;preflight:StoppedProgressPreflight;expected:{clientSource:string;serverSource:string;runnerSha256:string;packetSha256:string;priorLedgerSha256:string}}){
 const{recovery:r,receipt:n,ledger,preflight:p,expected:e}=input,h=await inspectControlledProgressHistory(input),a=h.initialReceipt;
 await inspectStoppedProgress({releaseRoot:input.releaseRoot,ledger,recovery:r.history,receipt:a,preflight:p,expected:{...e,clientSource:a.clientSource,serverSource:a.serverSource,runnerSha256:a.runnerSha256,packetSha256:a.packetSha256},metadataReceipts:[a,h.originalReceipt]});
 const canonical=(await read(r.canonicalWork)).value,w=canonical?.work,now=Date.now();
 if(canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||Date.parse(canonical.checkedAt)!==p.checkedAtMs||canonical.activeWorkLeases!==0
   ||w?.workId!==h.workId||w.caseId!==h.caseId||w.agentId!==h.actorId||w.status!=='retryable'||!Number.isSafeInteger(w.attempts)||w.attempts<1
   ||w.retryAt!=null&&(!Number.isFinite(Date.parse(w.retryAt))||Date.parse(w.retryAt)>now)
   ||!Array.isArray(w.sessions)||!w.sessions.length||w.sessions.some((s:any)=>s.status!=='ended'))refuse('FRESH_CANONICAL_RETRYABLE_WORK_REQUIRED');
 const target=(await read(r.targetPacket)).value,approval=(await read(r.adoption)).value,old=h.originalReceipt,start=Date.parse(n.startUtc),end=Date.parse(n.hardStopUtc);
 if(n.version!==1||n.ownerApproved!==true||n.modelCap!==64||n.ciHead!==n.clientSource||n.ciPassed!==true||n.clientSource!==e.clientSource||n.serverSource!==old.serverSource||n.serverSource!==e.serverSource
   ||n.runnerSha256!==e.runnerSha256||n.packetSha256!==e.packetSha256||n.packetSha256!==r.targetPacket.sha256||n.approvalReceiptSha256!==r.adoption.sha256
   ||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end<=start||end-start>5400000||!/^[a-f0-9]{40}$/.test(n.clientSource)||!/^[a-f0-9]{64}$/.test(n.runnerSha256)
   ||target.clientSource!==n.clientSource||target.serverSource!==n.serverSource||target.library?.sha256!==n.runnerSha256||path.resolve(target.oldKitRoot??'')!==path.resolve(input.releaseRoot)
   ||target.carriedStateSha256!==r.state.sha256||hashReviewedContinuationPlan(target.reviewedGraph)!==ledger.reviewedPlan?.planSha256)refuse('EXACT_CONTROLLED_SOURCE_ADOPTION_REQUIRED');
 const exact={purpose:'phase-c-explicit-controlled-progress-recovery',version:1,owner:'pjsk02',ownerApproved:true,priorWindow:h.priorWindow,priorExecutionSha256:r.execution.sha256,priorStateSha256:r.state.sha256,
   priorLedgerSha256:r.ledger.sha256,checkpointSha256:r.checkpoint.sha256,carrySha256:r.carry.sha256,clientSource:n.clientSource,serverSource:n.serverSource,runnerSha256:n.runnerSha256,packetSha256:n.packetSha256,
   modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:ledger.snapshot().chargedAttempts,currentOperations:p.conservativeMessages,currentCanonicalMessages:p.canonicalEffects,currentCases:p.cases,currentAssets:p.assets,
   repeatOnboarding:false,replayAcceptedSends:false,repeatObservedControls:false};
 if(Object.keys(approval).sort().join()!==[...Object.keys(exact),'decisionId','receivedAtUtc','timeMode','maximumIntervalMs'].sort().join()||Object.entries(exact).some(([k,v])=>approval[k]!==v)
   ||typeof approval.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(approval.decisionId)||!Number.isFinite(Date.parse(approval.receivedAtUtc))||Date.parse(approval.receivedAtUtc)>now)refuse('EXACT_CONTROLLED_RECOVERY_DECISION_REQUIRED');
 if(approval.timeMode==='same-fixed'){if(start!==Date.parse(old.startUtc)||end!==Date.parse(old.hardStopUtc)||approval.maximumIntervalMs!==5400000)refuse('ORIGINAL_CONTROLLED_DEADLINE_REQUIRED');}
 else if(approval.timeMode!=='new-interval'||start<Date.parse(approval.receivedAtUtc)||start<Date.parse(old.startUtc)||!Number.isSafeInteger(approval.maximumIntervalMs)||approval.maximumIntervalMs<1||approval.maximumIntervalMs>5400000||end-start>approval.maximumIntervalMs)refuse('EXPLICIT_NEW_CONTROLLED_INTERVAL_REQUIRED');
 const marker=path.join(path.resolve(input.releaseRoot),'phase-c-recovery-time-'+hash('pjsk02\0'+approval.decisionId)+'.used.json');try{await fs.lstat(marker);refuse('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return{...h,async consume(){const f=await fs.open(marker,'wx',0o600);try{await f.writeFile(JSON.stringify({purpose:'phase-c-one-use-controlled-progress-recovery',decisionId:approval.decisionId,approvalSha256:r.adoption.sha256,priorWindow:h.priorWindow,window:hash(JSON.stringify(n)),timeMode:approval.timeMode}));await f.sync();}finally{await f.close();}}};
}
