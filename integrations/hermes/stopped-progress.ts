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
export type StoppedProgressRecovery=Readonly<{
  purpose:'phase-c-stopped-native-progress';priorExecution:ProgressPin;priorPacket:ProgressPin;priorState:ProgressPin;priorLedger:ProgressPin;stop:ProgressPin;
  actionLedger:ProgressPin;currentInventory:ProgressPin;
  completed:readonly Readonly<{flowId:string;journal:ProgressPin;nativeEvidence:ProgressPin;nativeTerminal:ProgressPin}>[];
  failed:readonly Readonly<{flowId:string;journal:ProgressPin;nativeTerminal:ProgressPin;canonicalSnapshot:ProgressPin}>[];
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
  const execution=await pinned(r.priorExecution),packet=await pinned(r.priorPacket),state=await pinned(r.priorState),prefix=await pinned(r.priorLedger,false),stopped=await pinned(r.stop);
  const old=execution.value,priorWindow=old?.window,oldReceipt=old?.receipt,s=state.value;
  if(!digest(priorWindow)||hash(JSON.stringify(oldReceipt))!==priorWindow||oldReceipt.ownerApproved!==true||oldReceipt.modelCap!==64
    ||oldReceipt.packetSha256!==old.packetSha256||!digest(old.packetSha256)||!Number.isFinite(Date.parse(oldReceipt.startUtc))
    ||!Number.isFinite(Date.parse(oldReceipt.hardStopUtc))||start<Date.parse(oldReceipt.startUtc)
    ||s.window!==priorWindow||!digest(s.planSha256)||!object(s.started)||!object(s.results)
    ||packet.value.purpose!=='phase-c-prepared-session'||packet.value.version!==1||r.priorPacket.sha256!==old.packetSha256
    ||typeof packet.value.oldKitRoot!=='string'||path.resolve(packet.value.oldKitRoot)!==path.resolve(input.releaseRoot)
    ||packet.value.clientSource!==oldReceipt.clientSource||packet.value.serverSource!==oldReceipt.serverSource||packet.value.librarySha256!==oldReceipt.runnerSha256
    ||!object(packet.value.program)||hash(JSON.stringify(canonical({...packet.value.program,windowId:priorWindow})))!==s.planSha256)
    refuse('ORIGINAL_PROGRESS_PROVENANCE_REQUIRED');
  const priorGraph=ledger.reviewedPlan,approvalRaw=ledger.reviewedGraphApprovalRaw;
  if(!priorGraph||!approvalRaw||!object(packet.value.reviewedGraph)||!object(old.graphApproval)
    ||hashReviewedContinuationPlan(packet.value.reviewedGraph)!==priorGraph.planSha256
    ||JSON.stringify(canonical(old.graphApproval))!==JSON.stringify(canonical(JSON.parse(approvalRaw))))refuse('ORIGINAL_PROGRESS_GRAPH_REQUIRED');
  const priorApproval=validateReviewedGraphApproval(approvalRaw,{planSha256:priorGraph.planSha256,window:priorWindow,
    clientSource:oldReceipt.clientSource,serverSource:oldReceipt.serverSource,packetSha256:old.packetSha256});
  if(priorApproval.approvalHash!==priorGraph.ownerApprovalHash||oldReceipt.ciPassed!==true||oldReceipt.ciHead!==oldReceipt.clientSource)refuse('ORIGINAL_PROGRESS_GRAPH_REQUIRED');
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
  if(stopped.value.state!=='stopped'||stopped.value.command!=='stop'||!Number.isFinite(Date.parse(stopped.value.appliedAtUtc))
    ||Date.parse(stopped.value.appliedAtUtc)<Date.parse(oldReceipt.startUtc)||Date.parse(stopped.value.appliedAtUtc)>now)refuse('PRIOR_PROGRESS_STOP_REQUIRED');
  const filename=path.join(path.resolve(input.releaseRoot),'phase-c-cumulative-requests.jsonl'),current=await fs.readFile(filename);
  if(path.resolve(ledger.filename)!==filename||ledger.window!==priorWindow||!prefix.raw.equals(current)||!current.toString().endsWith('\n')
    ||hash(current)!==ledger.contentSha256)refuse('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
  const rows=current.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
  const boundaries=rows.flatMap((row,i)=>(row.kind==='seed'||row.kind==='window')&&row.window===priorWindow?[i]:[]);
  if(boundaries.length!==1||!ledger.reviewedPlan)refuse('ORIGINAL_PROGRESS_LEDGER_WINDOW_REQUIRED');
  const recent=rows.slice(boundaries[0]);
  for(const row of recent){
    const ids=row.kind==='binding'||row.kind==='attempt'?[row.flow]:row.kind==='phase'?row.active:[];
    if(!Array.isArray(ids)||ids.some((id:string)=>!object(s.started[id])))refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
    if(row.kind==='binding'&&hash(s.started[row.flow].workId)!==row.canonicalWorkHash)refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
  }
  const completedIds=Object.keys(s.results).sort(),failedIds=Object.keys(s.started).filter(id=>!Object.hasOwn(s.results,id)).sort();
  if(new Set(r.completed.map(p=>p.flowId)).size!==r.completed.length||new Set(r.failed.map(p=>p.flowId)).size!==r.failed.length
    ||JSON.stringify(r.completed.map(p=>p.flowId).sort())!==JSON.stringify(completedIds)
    ||JSON.stringify(r.failed.map(p=>p.flowId).sort())!==JSON.stringify(failedIds))refuse('EVERY_PRIOR_NATIVE_OUTCOME_REQUIRED');
  for(const p of [...r.completed,...r.failed]){
    const work=s.started[p.flowId];if(typeof work.workId!=='string'||!/^msg_/.test(work.workId)
      ||work.caseId!==ledger.reviewedPlan.flowCases[p.flowId])refuse('PRIOR_NATIVE_WORK_NOT_RECONCILED');
  }
  for(const p of r.completed){
    const result=s.results[p.flowId],work=s.started[p.flowId],journal=await pinned(p.journal),evidence=await pinned(p.nativeEvidence),native=await pinned(p.nativeTerminal);
    if(result.workId!==work.workId||result.canonicalStatus!=='processed'||result.journalCompleted!==true||result.journalSha256!==p.journal.sha256
      ||journal.value.workId!==work.workId||journal.value.completed!==true||!Array.isArray(journal.value.pending)||journal.value.pending.length
      ||evidence.value.workId!==work.workId||!['journalRawBytes','sessionEndRawBytes','completeRawBytes'].every(k=>typeof evidence.value[k]==='string')||hash(evidence.value.journalRawBytes)!==p.journal.sha256
      ||hash(evidence.value.sessionEndRawBytes)!==result.actualEndSha256||hash(evidence.value.completeRawBytes)!==result.actualSettlementSha256
      ||p.nativeTerminal.sha256!==result.nativeTerminalSha256)refuse('PRIOR_COMPLETED_WORK_PROOF_REQUIRED');
    const complete=JSON.parse(evidence.value.completeRawBytes);
    if(complete.workId!==work.workId||complete.status!=='processed')refuse('PRIOR_COMPLETED_WORK_PROOF_REQUIRED');
    terminal(native.value,journal.value,'completed');
  }
  for(const p of r.failed){
    const work=s.started[p.flowId],journal=await pinned(p.journal),native=await pinned(p.nativeTerminal),canonical=await pinned(p.canonicalSnapshot);
    if(journal.value.workId!==work.workId||journal.value.completed!==false||!Array.isArray(journal.value.pending)||journal.value.pending.length)
      refuse('PRIOR_FAILED_JOURNAL_MUST_BE_PRESERVED');
    terminal(native.value,journal.value,'failed');
    const record=canonical.value,match=Array.isArray(record.messages)&&record.messages.filter((m:any)=>m.id===work.workId);
    if(record.case?.id!==work.caseId||!match||match.length!==1||match[0].caseId!==work.caseId||match[0].status!=='failed')
      refuse('PRIOR_CANONICAL_FAILURE_REQUIRED');
  }
  const snapshot=ledger.snapshot(),blockedFlows=new Set<string>(Object.keys(s.started)),blockedWorkHashes=new Set<string>(Object.values(s.started).map((w:any)=>hash(w.workId)));
  for(const row of rows){if(row.kind==='binding'){blockedFlows.add(row.flow);blockedWorkHashes.add(row.canonicalWorkHash);}if(row.kind==='phase')for(const id of row.active)blockedFlows.add(id);if(row.kind==='attempt')blockedFlows.add(row.flow);}
  return {originalReceipt:oldReceipt as ContinuationReceipt,priorWindow,priorPacketSha256:old.packetSha256 as string,priorStateSha256:r.priorState.sha256,
    priorProgramSha256:s.planSha256 as string,currentLedgerSha256:hash(current),blockedFlows:[...blockedFlows],blockedWorkHashes:[...blockedWorkHashes],
    accounting:{models:snapshot.chargedAttempts,operations:preflight.conservativeMessages,canonicalMessages:preflight.canonicalEffects}};
}
