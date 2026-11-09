// A logical provider iteration is not proof of a dispatched model request.
// This exception preserves a failed pre-dispatch journal; it never retries it.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ProgressPin} from './stopped-progress';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function refuse():never{throw Object.assign(Error('EXACT_UNFORWARDED_OBSERVER_STOP_REQUIRED'),{code:'EXACT_UNFORWARDED_OBSERVER_STOP_REQUIRED'});}
export async function readUnforwardedPin(pin:ProgressPin,parse=true){
 if(!pin||!path.isAbsolute(pin.path)||!/^[a-f0-9]{64}$/.test(pin.sha256))refuse();
 const s=await fs.lstat(pin.path);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>2000000)refuse();
 const raw=await fs.readFile(pin.path);if(hash(raw)!==pin.sha256)refuse();
 return{raw,value:parse?JSON.parse(raw.toString('utf8')):undefined};
}
const same=(a:any,b:any)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&path.resolve(a.path)===path.resolve(b.path);
export async function inspectUnforwardedObserverStop(input:{pin:ProgressPin;packet:any;proof:any;execution:any;checkpoint:any;workId:string;caseId:string}){
 const{packet:p,proof:f,execution:e,checkpoint:c,workId,caseId}=input,q=(await readUnforwardedPin(input.pin)).value;
 if(q.purpose!=='actual-observer-order-zero-forwarding-stop-readonly'||q.primaryCode!=='ACTUAL_OWNED_NATIVE_CHILD_REQUIRED'
  ||q.outerCode!=='SCOPED_PROVIDER_UNAVAILABLE'||q.secondaryCode!=='ACTUAL_LOST_RESPONSE_AND_IDENTICAL_REPLAY_REQUIRED'
  ||q.logicalProviderIterations!==1||q.physicalRequestsAdded!==0||q.modelsAdded!==0
  ||['nativeBootstrapAdmitted','nativeHarnessObserved','nativePhysicalObserved','nativeResponseObserved','canonicalProcessed','taskReplayPerformed','oldAcceptedSendsRepeated','completedControlsRepeated','wholeGateComplete'].some(k=>q[k]!==false)
  ||!same(q.packet,f.packet)||!same(q.execution,f.execution)||!same(q.stop,f.stop)||!same(q.adoption,f.adoption)||!same(q.ledger,f.ledger)
  ||!same(q.programState,f.preTarget.state)||!same(q.events,f.preTarget.events)||!same(q.ownerGatewayContext,f.preTarget.ownerGatewayContext)
  ||q.usage?.chargedAttempts!==c.usage.chargedAttempts||q.usage.pending!==0||q.usage.unresolvedDispatches!==0
  ||!Number.isFinite(Date.parse(q.checkedAtUtc))||Date.parse(q.checkedAtUtc)<Date.parse(c.stopState.observedAtUtc)||Date.parse(q.checkedAtUtc)>Date.now())refuse();
 const expected=path.join(p.states.openclaw,'scoped-runs',workId+'.json');
 if(path.resolve(q.journal?.path??'')!==path.resolve(expected))refuse();
 const j=(await readUnforwardedPin(q.journal)).value;
 if(j.version!==1||j.workId!==workId||j.completed!==false||j.providerCalls!==1||!Array.isArray(j.pending)||j.pending.length
  ||typeof j.model!=='string'||!j.model.startsWith('openclaw:')||!Array.isArray(j.input)||j.input.length!==2
  ||j.input[0].role!=='system'||j.input[1].role!=='user'||j.input.some((x:any)=>Object.keys(x).sort().join()!=='content,role'||typeof x.content!=='string'))refuse();
 const canonical=(await readUnforwardedPin(q.canonical)).value,w=canonical.work;
 if(canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||canonical.activeWorkLeases!==0||canonical.activeCaseSessions!==0
  ||w?.workId!==workId||w.caseId!==caseId||w.agentId!==p.actors.openclaw.agentId||w.status!=='failed'||w.attempts!==5||w.failure?.retryable!==false||w.failure.reasonCode!=='HANDLER_FAILED'
  ||canonical.message?.status!=='failed'||canonical.message.processedAt!=null||!Array.isArray(canonical.sessions)||!canonical.sessions.length||canonical.sessions.some((s:any)=>s.status!=='ended'))refuse();
 const local=(await readUnforwardedPin(q.local)).value;
 if(!same(local.journal,q.journal)||local.modelsAdded!==0||!Array.isArray(local.ports)||local.ports.length!==3||local.ports.some((x:any)=>x.listening!==false))refuse();
 if(!Array.isArray(q.privateCauses)||q.privateCauses.length!==2)refuse();
 const primary=(await readUnforwardedPin(q.privateCauses[0],false)).raw.toString(),secondary=(await readUnforwardedPin(q.privateCauses[1],false)).raw.toString();
 if(!primary.includes(q.primaryCode)||!primary.includes('observeTransport')||!secondary.includes(q.secondaryCode))refuse();
 // Every saved personal review is retained, but none is a native result.
 if(!Array.isArray(q.ownerRequests)||q.ownerRequests.length!==1||!Array.isArray(q.nativeEvidence)||q.nativeEvidence.length!==2)refuse();
 for(const entry of q.ownerRequests){const request=(await readUnforwardedPin(entry.request)).value,response=(await readUnforwardedPin(entry.response)).value;
  if(path.dirname(entry.request.path)!==path.join(p.directory,'owner-requests')||path.dirname(entry.response.path)!==path.join(p.directory,'owner-requests')
   ||request.window!==e.window||response.window!==e.window||request.hardStopUtc!==e.receipt.hardStopUtc||path.resolve(request.receiptPath)!==path.resolve(entry.response.path))refuse();}
 for(const pin of q.nativeEvidence){if(path.dirname(pin.path)!==path.join(p.directory,'openclaw-evidence')||!/^(actual-owner-decisions|personal-review-subjects)-/.test(path.basename(pin.path)))refuse();await readUnforwardedPin(pin);}
 const exactFiles=async(dir:string,pins:ProgressPin[])=>{const actual=(await fs.readdir(dir)).sort(),wanted=pins.map(x=>path.basename(x.path)).sort();if(JSON.stringify(actual)!==JSON.stringify(wanted))refuse();};
 await exactFiles(path.join(p.directory,'owner-requests'),q.ownerRequests.flatMap((x:any)=>[x.request,x.response]));
 await exactFiles(path.join(p.directory,'openclaw-evidence'),q.nativeEvidence);
 if(!Array.isArray(q.originalJournals)||q.originalJournals.length!==9||!Array.isArray(q.modelFiles)||q.modelFiles.length!==6)refuse();
 for(const pin of [...q.originalJournals,...q.modelFiles])await readUnforwardedPin(pin,false);
 await readUnforwardedPin(q.actionLedger,false);await readUnforwardedPin(q.seal);
 return{journal:q.journal as ProgressPin,canonical:q.canonical as ProgressPin};
}
