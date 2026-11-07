// Read-only admission of a stopped, partially completed run. No runtime, claim,
// provider, ledger mutation, source adoption or time decision is performed here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ContinuationReceipt,ContinuationPreflight} from './continuation-controller';
import type {RecoveryTimeLink} from './recovery-time';
import type {RequestBudgetLedger} from './request-budget';
import {hashReviewedContinuationPlan,validateReviewedGraphApproval} from './continuation-plan';

export type ProgressPin=Readonly<{path:string;sha256:string}>;
export type StoppedProgressPreflight=Omit<ContinuationPreflight,'actualHermesCalls'|'actualOpenClawCalls'|'conservativeMessages'|'canonicalEffects'|'cases'|'assets'> & Readonly<{
  actualHermesCalls:number;actualOpenClawCalls:number;conservativeMessages:number;canonicalEffects:number;cases:number;assets:number;
}>;
export type StoppedProgressHistory=Readonly<{
  priorExecution:ProgressPin;priorPacket:ProgressPin;priorState:ProgressPin;priorLedger:ProgressPin;stop:ProgressPin;
  localHostStop?:ProgressPin;
  completed:readonly Readonly<{flowId:string;journal:ProgressPin;nativeEvidence:ProgressPin;nativeTerminal:ProgressPin}>[];
  failed:readonly Readonly<{flowId:string;journal:ProgressPin;nativeTerminal:ProgressPin;canonicalSnapshot:ProgressPin}>[];
}>;
export type StoppedProgressRecovery=StoppedProgressHistory & Readonly<{
  purpose:'phase-c-stopped-native-progress';actionLedger:ProgressPin;currentInventory:ProgressPin;
  // Newest first. Each ancestor must be pinned by its child's original packet;
  // these are historical prefixes, never replacements for the current ledger.
  ancestors?:readonly StoppedProgressHistory[];
  time:RecoveryTimeLink;
}>;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
async function pinned(pin:ProgressPin,parse=true){
  if(!pin||!path.isAbsolute(pin.path)||!digest(pin.sha256))refuse('EXACT_PROGRESS_PIN_REQUIRED');
  const s=await fs.lstat(pin.path);if(!s.isFile()||s.isSymbolicLink()||s.size<=0||s.size>2000000)refuse('BOUNDED_PROGRESS_PIN_REQUIRED');
  const raw=await fs.readFile(pin.path);if(hash(raw)!==pin.sha256)refuse('STOPPED_PROGRESS_EVIDENCE_CHANGED');
  return {raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};
}
function terminal(value:any,journal:any,outcome:'completed'|'failed'){
  const receipt=value?.result??value,frame=journal?.input?.[0];
  if(!object(receipt)||receipt.status!=='terminal'||!frame||typeof frame.sessionId!=='string'||typeof frame.admissionId!=='string'
    ||receipt.ref?.session_id!==frame.sessionId||receipt.admission_id!==frame.admissionId
    ||receipt.input_id!==undefined&&receipt.input_id!==frame.inputId
    ||(outcome==='completed'?receipt.outcome!=='completed':!['failed','interrupted','cancelled','rejected'].includes(receipt.outcome)))
    refuse('GENUINE_PRIOR_NATIVE_TERMINAL_REQUIRED');
}
const samePin=(a:any,b:ProgressPin)=>object(a)&&typeof a.path==='string'&&path.resolve(a.path)===path.resolve(b.path)&&a.sha256===b.sha256;
async function inspectHistory(r:StoppedProgressHistory,context:{releaseRoot:string;rows:any[];current:Buffer;now:number;nextStart:number}){
  if(!r||!Array.isArray(r.completed)||!Array.isArray(r.failed))refuse('EXACT_STOPPED_PROGRESS_REQUIRED');
  const execution=await pinned(r.priorExecution),packet=await pinned(r.priorPacket),state=await pinned(r.priorState),prefix=await pinned(r.priorLedger,false),stopped=await pinned(r.stop);
  const old=execution.value,priorWindow=old?.window,oldReceipt=old?.receipt,s=state.value,p=packet.value;
  const modern=old?.graphApprovalRaw!==undefined||old?.approvalSha256!==undefined;
  const packetSha=oldReceipt?.packetSha256,librarySha=p?.librarySha256??p?.library?.sha256;
  if(!digest(priorWindow)||!object(oldReceipt)||hash(JSON.stringify(oldReceipt))!==priorWindow||oldReceipt.ownerApproved!==true||oldReceipt.modelCap!==64
    ||!digest(packetSha)||!digest(librarySha)||!(/^[a-f0-9]{40}$/.test(oldReceipt.clientSource))||!(/^[a-f0-9]{40}$/.test(oldReceipt.serverSource))||old.packetSha256!==undefined&&old.packetSha256!==packetSha
    ||modern&&(typeof old.graphApprovalRaw!=='string'||old.approvalSha256!==oldReceipt.approvalReceiptSha256)
    ||!modern&&old.packetSha256!==packetSha||!digest(oldReceipt.approvalReceiptSha256)
    ||!Number.isFinite(Date.parse(oldReceipt.startUtc))||!Number.isFinite(Date.parse(oldReceipt.hardStopUtc))
    ||Date.parse(oldReceipt.hardStopUtc)<=Date.parse(oldReceipt.startUtc)||Date.parse(oldReceipt.hardStopUtc)-Date.parse(oldReceipt.startUtc)>5400000
    ||context.nextStart<Date.parse(oldReceipt.startUtc)||s?.window!==priorWindow||!digest(s.planSha256)||!object(s.started)||!object(s.results)
    ||!['phase-c-prepared-session','phase-c-prepared-stopped-progress-session'].includes(p?.purpose)||p.version!==1||r.priorPacket.sha256!==packetSha
    ||typeof p.oldKitRoot!=='string'||path.resolve(p.oldKitRoot)!==path.resolve(context.releaseRoot)
    ||p.clientSource!==oldReceipt.clientSource||p.serverSource!==oldReceipt.serverSource||librarySha!==oldReceipt.runnerSha256
    ||p.library!==undefined&&(!object(p.library)||p.library.sha256!==librarySha||typeof p.library.path!=='string'||!path.isAbsolute(p.library.path)||!Number.isSafeInteger(p.library.bytes)||p.library.bytes<=0)
    ||p.purpose==='phase-c-prepared-stopped-progress-session'&&!object(p.library)
    ||!object(p.program)||hash(JSON.stringify(canonical({...p.program,windowId:priorWindow})))!==s.planSha256)
    refuse('ORIGINAL_PROGRESS_PROVENANCE_REQUIRED');
  const boundaries=context.rows.flatMap((row,i)=>(row.kind==='seed'||row.kind==='window')&&row.window===priorWindow?[i]:[]);
  if(boundaries.length!==1)refuse('ORIGINAL_PROGRESS_LEDGER_WINDOW_REQUIRED');
  const begin=boundaries[0],next=context.rows.findIndex((row,i)=>i>begin&&(row.kind==='seed'||row.kind==='window'));
  const end=next===-1?context.rows.length:next,recent=context.rows.slice(begin,end),exactPrefix=Buffer.from(context.rows.slice(0,end).map(row=>JSON.stringify(row)+'\n').join(''));
  if(!prefix.raw.equals(exactPrefix)||!context.current.subarray(0,prefix.raw.length).equals(prefix.raw))refuse('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
  const plans=recent.filter(row=>row.kind==='plan'),planRow=plans.at(-1),priorGraph=planRow?.plan,approvalRaw=planRow?.proof?.graphApprovalRaw;
  if(!priorGraph||typeof approvalRaw!=='string'||!object(p.reviewedGraph)
    ||hashReviewedContinuationPlan(p.reviewedGraph)!==priorGraph.planSha256
    ||modern&&old.graphApprovalRaw!==approvalRaw||!modern&&!object(old.graphApproval)
    ||old.graphApproval!==undefined&&JSON.stringify(canonical(old.graphApproval))!==JSON.stringify(canonical(JSON.parse(approvalRaw))))refuse('ORIGINAL_PROGRESS_GRAPH_REQUIRED');
  const priorApproval=validateReviewedGraphApproval(approvalRaw,{planSha256:priorGraph.planSha256,window:priorWindow,
    clientSource:oldReceipt.clientSource,serverSource:oldReceipt.serverSource,packetSha256:packetSha});
  if(priorApproval.approvalHash!==priorGraph.ownerApprovalHash||oldReceipt.ciPassed!==true||oldReceipt.ciHead!==oldReceipt.clientSource)refuse('ORIGINAL_PROGRESS_GRAPH_REQUIRED');
  const observed=Date.parse(stopped.value?.appliedAtUtc??stopped.value?.observedAtUtc),legacy=stopped.value?.state==='stopped'&&stopped.value?.command==='stop';
  if(!Number.isFinite(observed)||observed<Date.parse(oldReceipt.startUtc)||observed>context.now||observed>context.nextStart
    ||stopped.value.window!==undefined&&stopped.value.window!==priorWindow||legacy&&stopped.value.purpose==='phase-c-actual-auth-stop-observation')refuse('PRIOR_PROGRESS_STOP_REQUIRED');
  if(!legacy){
    // A Ctrl+C observation is not a normal stop command or a cleanup PASS.
    // Only the already expired window plus recorded process/endpoint absence
    // and the separate fresh all-host preflight can admit this bounded path.
    if(stopped.value.purpose!=='phase-c-actual-auth-stop-observation'||stopped.value.window!==priorWindow||stopped.value.interruptSent!==true
      ||!Number.isSafeInteger(stopped.value.observedExitCode)||stopped.value.observedExitCode===0||stopped.value.ownedHermesProcessesPresent!==0
      ||Date.parse(oldReceipt.hardStopUtc)>context.now||!r.localHostStop)refuse('PRIOR_PROGRESS_STOP_REQUIRED');
    const local=(await pinned(r.localHostStop)).value,checked=Date.parse(local?.checkedAtUtc),roles=['je1','je2','testowner'];
    const postInterrupt=local?.purpose==='phase-c-local-post-interrupt-host-observation'&&local.readOnly===true&&local.allSelectedHermesUnreachable===true
      &&Array.isArray(local.hosts)&&local.hosts.length===3&&roles.every(role=>local.hosts.filter((h:any)=>h.role===role&&h.stopped===true&&h.code==='HERMES_DAEMON_UNREACHABLE').length===1);
    const postExpiry=local?.purpose==='post-window-actual-readonly-readiness'&&local.originalHardStopUtc===oldReceipt.hardStopUtc&&local.originalWindowExpired===true
      &&checked>=Date.parse(oldReceipt.hardStopUtc)&&local.authRefreshes===0&&local.tasksSent===0&&local.hostsStarted===0
      &&Array.isArray(local.profiles)&&local.profiles.length===3&&roles.every(role=>local.profiles.filter((h:any)=>h.role===role&&h.gatewayReachable===false&&h.code==='HERMES_DAEMON_UNREACHABLE').length===1);
    if(!postInterrupt&&!postExpiry||local.modelsAdded!==0||local.claimsIssued!==0||!Number.isFinite(checked)||checked<observed||checked>context.now)refuse('PRIOR_PROGRESS_STOP_REQUIRED');
  }
  for(const row of recent){
    const ids=row.kind==='binding'||row.kind==='attempt'?[row.flow]:row.kind==='phase'?row.active:[];
    if(!Array.isArray(ids)||ids.some((id:string)=>!object(s.started[id])))refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
    if(row.kind==='binding'&&hash(s.started[row.flow].workId)!==row.canonicalWorkHash)refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
  }
  const completedIds=Object.keys(s.results).sort(),failedIds=Object.keys(s.started).filter(id=>!Object.hasOwn(s.results,id)).sort();
  if(new Set(r.completed.map(p=>p.flowId)).size!==r.completed.length||new Set(r.failed.map(p=>p.flowId)).size!==r.failed.length
    ||JSON.stringify(r.completed.map(p=>p.flowId).sort())!==JSON.stringify(completedIds)
    ||JSON.stringify(r.failed.map(p=>p.flowId).sort())!==JSON.stringify(failedIds))refuse('EVERY_PRIOR_NATIVE_OUTCOME_REQUIRED');
  for(const proof of [...r.completed,...r.failed]){
    const work=s.started[proof.flowId];if(typeof work.workId!=='string'||!/^msg_/.test(work.workId)||work.caseId!==priorGraph.flowCases[proof.flowId])refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
  }
  for(const proof of r.completed){
    const result=s.results[proof.flowId],work=s.started[proof.flowId],journal=await pinned(proof.journal),evidence=await pinned(proof.nativeEvidence),native=await pinned(proof.nativeTerminal);
    if(result.workId!==work.workId||result.canonicalStatus!=='processed'||result.journalCompleted!==true||result.journalSha256!==proof.journal.sha256
      ||journal.value.workId!==work.workId||journal.value.completed!==true||!Array.isArray(journal.value.pending)||journal.value.pending.length
      ||evidence.value.workId!==work.workId||!['journalRawBytes','sessionEndRawBytes','completeRawBytes'].every(k=>typeof evidence.value[k]==='string')||hash(evidence.value.journalRawBytes)!==proof.journal.sha256
      ||hash(evidence.value.sessionEndRawBytes)!==result.actualEndSha256||hash(evidence.value.completeRawBytes)!==result.actualSettlementSha256
      ||proof.nativeTerminal.sha256!==result.nativeTerminalSha256)refuse('PRIOR_COMPLETED_WORK_PROOF_REQUIRED');
    const complete=JSON.parse(evidence.value.completeRawBytes);
    if(complete.workId!==work.workId||complete.status!=='processed')refuse('PRIOR_COMPLETED_WORK_PROOF_REQUIRED');
    terminal(native.value,journal.value,'completed');
  }
  for(const proof of r.failed){
    const work=s.started[proof.flowId],journal=await pinned(proof.journal),native=await pinned(proof.nativeTerminal),record=(await pinned(proof.canonicalSnapshot)).value;
    if(journal.value.workId!==work.workId||journal.value.completed!==false||!Array.isArray(journal.value.pending)||journal.value.pending.length)refuse('PRIOR_FAILED_JOURNAL_MUST_BE_PRESERVED');
    terminal(native.value,journal.value,'failed');
    const match=Array.isArray(record.messages)&&record.messages.filter((m:any)=>m.id===work.workId);
    if(record.case?.id!==work.caseId||!match||match.length!==1||match[0].caseId!==work.caseId||match[0].status!=='failed')refuse('PRIOR_CANONICAL_FAILURE_REQUIRED');
  }
  return {packet:p,state:s,receipt:oldReceipt as ContinuationReceipt,window:priorWindow,packetSha,begin,end};
}
function joinAncestor(child:Awaited<ReturnType<typeof inspectHistory>>,parent:Awaited<ReturnType<typeof inspectHistory>>,pin:StoppedProgressHistory){
  const h=child.packet.historyPins,c=child.state.carriedProgress;
  if(!object(h)||!['priorExecution','priorPacket','priorState','priorLedger','stop'].every(key=>samePin(h[key],pin[key as keyof StoppedProgressHistory] as ProgressPin))
    ||child.begin!==parent.end||child.window===parent.window||!Array.isArray(h.completed)||h.completed.length!==pin.completed.length
    ||pin.completed.some(p=>!h.completed.some((q:any)=>q.flowId===p.flowId&&['journal','nativeEvidence','nativeTerminal'].every(key=>samePin(q[key],p[key as keyof typeof p] as ProgressPin))))
    ||pin.failed.length!==1||!samePin(h.failedReceipt?.journal,pin.failed[0].journal)||h.failedReceipt?.workId!==parent.state.started[pin.failed[0].flowId]?.workId
    ||!object(c)||c.priorWindow!==parent.window||c.priorClientSource!==parent.receipt.clientSource||c.stateSha256!==pin.priorState.sha256
    ||JSON.stringify(canonical(c.completedResults))!==JSON.stringify(canonical(parent.state.results))
    ||!Array.isArray(c.completedFlows)||JSON.stringify([...c.completedFlows].sort())!==JSON.stringify(Object.keys(parent.state.results).sort())
    ||!Array.isArray(c.blockedWorkIds)||Object.values(parent.state.started).some((w:any)=>!c.blockedWorkIds.includes(w.workId)))refuse('EXACT_PROGRESS_ANCESTRY_REQUIRED');
}
/** Read-only historical format/provenance inspection. This grants no start
 * handle, current inventory credit, source adoption, time or model authority. */
export async function inspectStoppedProgressHistory(input:{releaseRoot:string;recovery:StoppedProgressHistory&{ancestors?:readonly StoppedProgressHistory[]};ledger:RequestBudgetLedger;nextStart?:number}){
  const {recovery:r,ledger}=input,filename=path.join(path.resolve(input.releaseRoot),'phase-c-cumulative-requests.jsonl'),current=await fs.readFile(filename),prefix=await pinned(r.priorLedger,false);
  if(path.resolve(ledger.filename)!==filename||!prefix.raw.equals(current)||!current.toString().endsWith('\n')||hash(current)!==ledger.contentSha256)refuse('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
  const rows=current.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
  if(r.ancestors!==undefined&&(!Array.isArray(r.ancestors)||r.ancestors.length>8))refuse('EXACT_PROGRESS_ANCESTRY_REQUIRED');
  const histories=[r,...r.ancestors??[]],runs=[],now=Date.now(),nextStart=input.nextStart??now;
  if(!Number.isFinite(nextStart)||nextStart>now)refuse('PRIOR_PROGRESS_STOP_REQUIRED');
  for(let i=0;i<histories.length;i++){
    const run=await inspectHistory(histories[i],{releaseRoot:input.releaseRoot,rows,current,now,nextStart:i?Date.parse(runs[i-1].receipt.startUtc):nextStart});
    if(i===0&&run.window!==ledger.window)refuse('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
    if(i)joinAncestor(runs[i-1],run,histories[i]);
    if((run.packet.purpose==='phase-c-prepared-stopped-progress-session')!==(i<histories.length-1))refuse('EXACT_PROGRESS_ANCESTRY_REQUIRED');
    runs.push(run);
  }
  const latest=runs[0],blockedFlows=new Set<string>(),blockedWorkHashes=new Set<string>();
  for(const run of runs)for(const[id,work]of Object.entries(run.state.started) as [string,any][]){blockedFlows.add(id);blockedWorkHashes.add(hash(work.workId));}
  for(const row of rows){if(row.kind==='binding'){blockedFlows.add(row.flow);blockedWorkHashes.add(row.canonicalWorkHash);}if(row.kind==='phase')for(const id of row.active)blockedFlows.add(id);if(row.kind==='attempt')blockedFlows.add(row.flow);}
  return {originalReceipt:latest.receipt,priorWindow:latest.window,priorPacketSha256:latest.packetSha as string,priorStateSha256:r.priorState.sha256,
    priorProgramSha256:latest.state.planSha256 as string,currentLedgerSha256:hash(current),blockedFlows:[...blockedFlows],blockedWorkHashes:[...blockedWorkHashes]};
}
export function assertStoppedProgressPreflight(p:StoppedProgressPreflight,ledger:RequestBudgetLedger,now=Date.now()){
  const s=ledger.snapshot();
  if(!Number.isFinite(p.checkedAtMs)||p.checkedAtMs>now||now-p.checkedAtMs>300000||p.allSelectedHostsStopped!==true
    ||p.activeLeases!==0||p.protectedCasePaused!==true||p.originalDispositionMatches!==true||ledger.modelCap!==64||s.pending||s.unresolvedDispatches
    ||p.actualHermesCalls!==24+s.knownHermesDispatches||p.actualOpenClawCalls!==6+s.knownOpenClawDispatches
    ||!Number.isSafeInteger(p.conservativeMessages)||p.conservativeMessages<22||p.conservativeMessages>60
    ||!Number.isSafeInteger(p.canonicalEffects)||p.canonicalEffects<9||p.canonicalEffects>p.conservativeMessages
    ||!Number.isSafeInteger(p.cases)||p.cases<4||p.cases>9||p.newInstallations!==5
    ||!Number.isSafeInteger(p.assets)||p.assets<0||p.assets>6)refuse('FRESH_STOPPED_PROGRESS_PREFLIGHT_REQUIRED');
  // This bounded path reconciles the retained Hermes admissions before the
  // first Phase C OpenClaw processing group; other native formats fail closed.
  if(s.knownOpenClawDispatches!==0)refuse('PRIOR_OPENCLAW_PROGRESS_REQUIRES_SEPARATE_RECOVERY');
}
export async function inspectStoppedProgress(input:{releaseRoot:string;receipt:ContinuationReceipt;preflight:StoppedProgressPreflight;
  expected:{clientSource:string;serverSource:string;runnerSha256:string;packetSha256:string;priorLedgerSha256:string};
  recovery:StoppedProgressRecovery;ledger:RequestBudgetLedger}){
  const {recovery:r,ledger,receipt,expected,preflight}=input,now=Date.now(),start=Date.parse(receipt.startUtc),stop=Date.parse(receipt.hardStopUtc);
  if(r?.purpose!=='phase-c-stopped-native-progress'||!Array.isArray(r.completed)||!Array.isArray(r.failed))refuse('EXACT_STOPPED_PROGRESS_REQUIRED');
  if(receipt.version!==1||receipt.ownerApproved!==true||receipt.modelCap!==64||!digest(receipt.approvalReceiptSha256)||!digest(receipt.packetSha256)
    ||!(/^[a-f0-9]{40}$/.test(receipt.clientSource))||!(/^[a-f0-9]{40}$/.test(receipt.serverSource))||!digest(receipt.runnerSha256)
    ||receipt.clientSource!==expected.clientSource||receipt.serverSource!==expected.serverSource||receipt.runnerSha256!==expected.runnerSha256
    ||receipt.packetSha256!==expected.packetSha256||receipt.ciHead!==receipt.clientSource||receipt.ciPassed!==true
    ||!Number.isFinite(start)||!Number.isFinite(stop)||start>now||stop<=now||stop<=start||stop-start>5400000)refuse('FRESH_EXACT_CONTINUATION_APPROVAL_REQUIRED');
  assertStoppedProgressPreflight(preflight,ledger,now);
  const history=await fs.readFile(path.join(input.releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'));
  if(!digest(expected.priorLedgerSha256)||hash(history)!==expected.priorLedgerSha256)refuse('PRIOR_LEDGER_CHANGED');
  const actions=await pinned(r.actionLedger,false),actionFile=path.join(input.releaseRoot,'phase-c-cumulative-actions.jsonl');
  if(!actions.raw.equals(await fs.readFile(actionFile))||!actions.raw.toString().endsWith('\n'))refuse('CURRENT_ACTION_LEDGER_REQUIRED');
  let previous='0'.repeat(64);const actionRows=actions.raw.toString().trimEnd().split('\n').map(line=>{const row=JSON.parse(line);if(row.previous!==previous)refuse('ACTION_LEDGER_CHAIN_CHANGED');previous=hash(line+'\n');return row;});
  const seed=actionRows[0],anchor=JSON.parse(await fs.readFile(path.join(input.releaseRoot,'phase-c-action-ledger.anchor'),'utf8'));
  if(seed.kind!=='seed'||seed.priorSha256!==expected.priorLedgerSha256||anchor.seedSha256!==hash(JSON.stringify(seed)+'\n')
    ||JSON.stringify(seed.prior)!==JSON.stringify(JSON.parse(history.toString()))||!Array.isArray(seed.prior.caseIds)||seed.prior.caseIds.length!==4
    ||actionRows.slice(1).some(row=>!['operation','asset'].includes(row.kind)))refuse('CURRENT_ACTION_LEDGER_REQUIRED');
  const cases=new Set(seed.prior.caseIds);for(const row of actionRows)if(row.caseId)cases.add(row.caseId);
  const operations=22+actionRows.filter(row=>row.kind==='operation').length,assets=actionRows.filter(row=>row.kind==='asset');
  if(operations>52||operations!==preflight.conservativeMessages||cases.size!==preflight.cases||assets.length!==preflight.assets
    ||assets.some(a=>!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>65536))refuse('CURRENT_ACTION_ACCOUNTING_REQUIRED');
  const inventory=(await pinned(r.currentInventory)).value;
  if(!object(inventory)||inventory.database!=='sinaloa_staging'||inventory.readOnly!=='on'||Date.parse(inventory.checkedAt)!==preflight.checkedAtMs
    ||inventory.activeWorkLeases!==0||inventory.activeCaseSessions!==0||inventory.protectedCaseState!=='paused'
    ||inventory.canonicalMessageEffects!==preflight.canonicalEffects||inventory.plannedCasesPresent!==preflight.cases
    ||inventory.pendingWakeDeliveries!==0||inventory.nonEndedSubscriptions!==0||inventory.originalRecordCount!==786||inventory.approvedRemovedOriginals!==3
    ||!Array.isArray(inventory.unexpectedOriginalDifferences)||inventory.unexpectedOriginalDifferences.length)refuse('CURRENT_CANONICAL_PROGRESS_INVENTORY_REQUIRED');
  const historicalProof=await inspectStoppedProgressHistory({releaseRoot:input.releaseRoot,recovery:r,ledger,nextStart:start}),snapshot=ledger.snapshot();
  return {...historicalProof,
    accounting:{models:snapshot.chargedAttempts,operations:preflight.conservativeMessages,canonicalMessages:preflight.canonicalEffects}};
}
