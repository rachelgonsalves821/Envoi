import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {ContinuationController,type ContinuationReceipt} from './continuation-controller';
import {RequestBudgetLedger} from './request-budget';
import {continuationAllocation,defaultContinuationFlowPolicy,hashReviewedContinuationPlan,type ReviewedContinuationPlan} from './continuation-plan';
import {authorizeRecoveryTime} from './recovery-time';
import {inspectStoppedProgressHistory,authorizePreProgramInterval} from './stopped-progress';
import {inspectControlledProgressHistory} from './controlled-progress';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),h=(v:string)=>hash(v),dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0)){if(!path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(dir).startsWith('envoi-progress-test-'))throw Error('CLEANUP_REFUSED');await fs.rm(dir,{recursive:true,force:true});}});
async function setup(){
 const root=await fs.mkdtemp(path.join(tmpdir(),'envoi-progress-test-'));dirs.push(root);
 const pin=async(name:string,value:unknown)=>{const raw=typeof value==='string'?value:JSON.stringify(value),file=path.join(root,name);await fs.writeFile(file,raw);return{path:file,sha256:hash(raw)};};
 const prior={actualCalls:30,actualHermesApiCalls:24,openClawProviderRequestsReserved:6,possibleHostMessageEffects:22,canonicalEffects:9,caseIds:['case_0','case_1','case_2','case_3'],newInstallationsUsed:5,priorUploadedAssets:0,stopped:true,failure:'LIVE_ASSERTION_FAILED'};
 const historical=await pin('budget-7c522b08c11f.terminal-dd4debf.json',prior);
 const actors={je1:'agent_je1',je2:'agent_je2',testowner:'agent_owner',openclaw:'agent_oc'};
 const cases=Object.fromEntries(continuationAllocation('bounded-contingency').map((f,i)=>[f.id,'case_'+i%4]));
 const specs:[string,keyof typeof actors,number][]=[['private-backlog','je2',1],['green','je1',1],['private-followup','je2',3],['amber-followup','je1',1],['private-receipt-review','je1',1],['accept-authority','testowner',2],['approved-accept-complete','testowner',4],['asset-share','testowner',4],['asset-read-proposal','je1',1],['asset-decline','testowner',3],['declined-resume','testowner',1],['openclaw','openclaw',3],['oc-shared-read-propose','openclaw',4],['oc-canary-no-action','openclaw',2],['oc-accepted-decision-no-action','openclaw',1],['hermes-final-proposal','je1',2]];
 const flows=specs.map(([id,role,requests])=>({id,role,requests,workHash:null,policy:defaultContinuationFlowPolicy(id)}));
 const flowCases={...cases,...Object.fromEntries(specs.map(([id],i)=>[id,cases[id]??'case_'+i%4]))};
 const sign=(graph:Omit<ReviewedContinuationPlan,'planSha256'|'ownerApprovalHash'>,receipt:ContinuationReceipt,id:string)=>{const planSha256=hashReviewedContinuationPlan(graph),raw=JSON.stringify({purpose:'phase-c-reviewed-graph-source-approval',version:1,ownerApproved:true,approvalId:'inert-'+id,planSha256,window:hash(JSON.stringify(receipt)),clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256});return{plan:{...graph,planSha256,ownerApprovalHash:hash(raw)},raw};};
 const graph={purpose:'phase-c-reviewed-graph' as const,version:1 as const,allowSameRoleCohorts:true,flows,flowCases,actorIds:actors};
 const program={fixture:'inert-only',windowId:'unstarted'},priorPacket=await pin('old-packet.json',{purpose:'phase-c-prepared-session',version:1,clientSource:'a'.repeat(40),serverSource:'b'.repeat(40),librarySha256:h('old library'),oldKitRoot:root,program,reviewedGraph:graph});
 const old:ContinuationReceipt={version:1,ownerApproved:true,approvalReceiptSha256:h('old approval'),packetSha256:priorPacket.sha256,clientSource:'a'.repeat(40),serverSource:'b'.repeat(40),runnerSha256:h('old library'),ciHead:'a'.repeat(40),ciPassed:true,modelCap:64,startUtc:new Date(Date.now()-2000).toISOString(),hardStopUtc:new Date(Date.now()+120000).toISOString()};
 const original=await ContinuationController.open({releaseRoot:root,receipt:old,preflight:{checkedAtMs:Date.now(),allSelectedHostsStopped:true,activeLeases:0,protectedCasePaused:true,originalDispositionMatches:true,actualHermesCalls:24,actualOpenClawCalls:6,conservativeMessages:22,canonicalEffects:9,cases:4,newInstallations:5,assets:0},expected:{clientSource:old.clientSource,serverSource:old.serverSource,runnerSha256:old.runnerSha256,packetSha256:old.packetSha256,priorLedgerSha256:historical.sha256},flowCases:cases,actorIds:actors});
 const oldSigned=sign(graph,old,'old');
 const proof=(receipt:ContinuationReceipt,raw:string,chargedAttempts:number)=>({expectedWindow:hash(JSON.stringify(receipt)),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts,graphApprovalRaw:raw,clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256});
 await original.ledger.amendReviewedPlan(oldSigned.plan,proof(old,oldSigned.raw,30));
 const used=['private-followup','amber-followup','private-receipt-review'];
 for(const id of used)await original.ledger.bindWork(id,{canonicalWorkHash:h('msg_'+id),nativeToken:h('token '+id),evidenceHash:h('evidence '+id)});
 await original.ledger.selectPhase('hermes',used.slice(0,2),Date.now()+60000);
 for(const [id,role,count]of [['private-followup','je2',3],['amber-followup','je1',1]] as const)for(let i=0;i<count;i++){const at=await original.ledger.reserve(role,h('token '+id));await original.ledger.markDispatched(at);await original.ledger.finish(at,'response');}
 await original.ledger.selectPhase('hermes',[used[2]],Date.now()+60000);const at=await original.ledger.reserve('je1',h('token '+used[2]));await original.ledger.markDispatched(at);await original.ledger.finish(at,'response');original.stop();
 const state:any={phase:'prepared',window:original.ledger.window,planSha256:hash(JSON.stringify({...program,windowId:original.ledger.window})),started:{},results:{},effects:{},controlProofs:{je2:{retained:true}},taskReceipts:{},followups:{},retiredProofs:{}};
 const completed:any[]=[],failed:any[]=[];
 for(const id of used){const done=id!==used[2],workId='msg_'+id,sessionId='session_'+id,admissionId='admission_'+id;
  state.started[id]={workId,caseId:flowCases[id],beforeSha256:h('before '+id)};
  const journal={version:1,model:'hermes-daemon:inert',workId,completed:done,pending:[],providerCalls:id===used[0]?3:1,input:[{kind:'hermes-scoped-v1',sessionId,admissionId}]},journalRaw=JSON.stringify(journal),jp=await pin(id+'-journal.json',journalRaw);
  const terminal=await pin(id+'-terminal.json',{jsonrpc:'2.0',id:1,result:{status:'terminal',outcome:done?'completed':'interrupted',ref:{session_id:sessionId},admission_id:admissionId}});
  if(done){const end=JSON.stringify({session:{status:'ended',outcome:'completed'}}),complete=JSON.stringify({workId,status:'processed'}),native=await pin(id+'-native.json',{workId,journalRawBytes:journalRaw,sessionEndRawBytes:end,completeRawBytes:complete});state.results[id]={workId,canonicalStatus:'processed',journalCompleted:true,journalSha256:jp.sha256,actualEndSha256:hash(end),actualSettlementSha256:hash(complete),nativeTerminalSha256:terminal.sha256};completed.push({flowId:id,journal:jp,nativeEvidence:native,nativeTerminal:terminal});}
  else failed.push({flowId:id,journal:jp,nativeTerminal:terminal,canonicalSnapshot:await pin('failed-canonical.json',{case:{id:flowCases[id]},messages:[{id:workId,caseId:flowCases[id],status:'failed'}]})});
 }
 const filename=path.join(root,'phase-c-cumulative-requests.jsonl'),prefix=await fs.readFile(filename,'utf8');
 const actionSeed={previous:'0'.repeat(64),kind:'seed',window:original.ledger.window,source:old.clientSource,priorSha256:historical.sha256,prior};let actions=JSON.stringify(actionSeed)+'\n',previous=hash(actions);
 for(let i=0;i<10;i++){const row=JSON.stringify({previous,kind:'operation',operationKind:'message',caseId:'case_0'})+'\n';actions+=row;previous=hash(row);}
 await pin('phase-c-cumulative-actions.jsonl',actions);await pin('phase-c-action-ledger.anchor',{seedSha256:hash(JSON.stringify(actionSeed)+'\n')});
 const checkedAt=new Date().toISOString(),currentInventory=await pin('current-inventory.json',{database:'sinaloa_staging',readOnly:'on',checkedAt,activeWorkLeases:0,activeCaseSessions:0,protectedCaseState:'paused',canonicalMessageEffects:12,plannedCasesPresent:4,pendingWakeDeliveries:0,nonEndedSubscriptions:0,originalRecordCount:786,approvedRemovedOriginals:3,unexpectedOriginalDifferences:[]});
 const recovery={purpose:'phase-c-stopped-native-progress' as const,priorExecution:await pin('old-execution.json',{window:original.ledger.window,receipt:old,packetSha256:old.packetSha256,graphApproval:JSON.parse(oldSigned.raw)}),priorPacket,priorState:await pin('old-state.json',state),priorLedger:await pin('old-ledger.jsonl',prefix),stop:await pin('old-stop.json',{state:'stopped',command:'stop',appliedAtUtc:new Date(Date.parse(old.startUtc)+500).toISOString()}),actionLedger:await pin('actions-snapshot.jsonl',actions),currentInventory,completed,failed,time:{mode:'same-fixed' as const}};
 const receipt:ContinuationReceipt={...old,clientSource:'d'.repeat(40),ciHead:'d'.repeat(40),packetSha256:h('new packet'),runnerSha256:h('new library'),approvalReceiptSha256:h('new approval'),startUtc:new Date(Date.now()-1000).toISOString()};
 const nextGraph={...graph,flows:[...flows.map(f=>['private-backlog','green','asset-read-proposal'].includes(f.id)?{...f,retired:true as const}:f),{id:'new-private-review',role:'je1' as const,requests:1,workHash:null,policy:{noAction:true,decisionOutcome:null,allowHumanEnd:false}}],flowCases:{...flowCases,'new-private-review':flowCases[used[2]]}},signed=sign(nextGraph,receipt,'new');
 const options={releaseRoot:root,receipt,preflight:{checkedAtMs:Date.parse(checkedAt),allSelectedHostsStopped:true as const,activeLeases:0 as const,protectedCasePaused:true as const,originalDispositionMatches:true as const,actualHermesCalls:29,actualOpenClawCalls:6,conservativeMessages:32,canonicalEffects:12,cases:4,newInstallations:5 as const,assets:0},expected:{clientSource:receipt.clientSource,serverSource:receipt.serverSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256,priorLedgerSha256:historical.sha256},flowCases:nextGraph.flowCases,actorIds:actors,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw,recovery};
 return{root,pin,original,filename,prefix,state,options,nextGraph,sign,proof,used};
}
// The second run uses the formats actually emitted by the stopped-progress
// operator: nested library pin and a raw graph approval, with inherited results
// in carriedProgress rather than new native starts. All identities are inert.
async function secondGeneration(postExpiry=false){
 const s=await setup(),parent=s.options.recovery;
 const packet=await s.pin('continued-packet.json',{purpose:'phase-c-prepared-stopped-progress-session',version:1,
  clientSource:s.options.receipt.clientSource,serverSource:s.options.receipt.serverSource,oldKitRoot:s.root,
  library:{path:path.join(s.root,'inert-library.mjs'),sha256:s.options.receipt.runnerSha256,bytes:1},program:{fixture:'inert-continued',windowId:'unstarted'},reviewedGraph:s.nextGraph,
  historyPins:{priorExecution:parent.priorExecution,priorPacket:parent.priorPacket,priorState:parent.priorState,priorLedger:parent.priorLedger,stop:parent.stop,completed:parent.completed,
   failedReceipt:{workId:s.state.started['private-receipt-review'].workId,journal:parent.failed[0].journal}}});
 const receipt={...s.options.receipt,packetSha256:packet.sha256},signed=s.sign(s.nextGraph,receipt,'continued actual-format');
 const c=await ContinuationController.startStoppedProgress(await ContinuationController.prepareStoppedProgress({...s.options,receipt,expected:{...s.options.expected,packetSha256:packet.sha256},reviewedPlan:signed.plan,graphApprovalRaw:signed.raw}));c.stop();
 const failed=parent.failed[0],ancestorReceipt=JSON.parse(await fs.readFile(parent.priorExecution.path,'utf8')).receipt;
 const window=hash(JSON.stringify(receipt)),state={window,planSha256:hash(JSON.stringify({fixture:'inert-continued',windowId:window})),started:{},results:{},taskReceipts:{shared:{state:'accepted',messageId:'msg_retained_shared'}},
  carriedProgress:{priorWindow:s.original.ledger.window,priorClientSource:JSON.parse(await fs.readFile(parent.priorExecution.path,'utf8')).receipt.clientSource,stateSha256:parent.priorState.sha256,
   completedFlows:Object.keys(s.state.results),completedResults:s.state.results,blockedWorkIds:Object.values(s.state.started).map((v:any)=>v.workId),
   receiptEvidenceSha256:hash(JSON.stringify({canonicalSnapshot:failed.canonicalSnapshot,flowId:failed.flowId,journal:failed.journal,nativeTerminal:failed.nativeTerminal})),
   receipt:{workId:s.state.started[failed.flowId].workId,canonicalStatus:'failed',nativeTerminalNegative:true,journalUnchanged:true,modelCallsAddedByReconciliation:0,originalAdmissionClientSource:ancestorReceipt.clientSource,dispositionReconciledByClientSource:receipt.clientSource}}};
 const now=Date.parse(receipt.hardStopUtc)+1000;vi.spyOn(Date,'now').mockReturnValue(now);
 const recovery:any={...parent,priorPacket:packet,priorExecution:await s.pin('continued-execution.json',{receipt,window,approvalSha256:receipt.approvalReceiptSha256,graphApprovalRaw:signed.raw}),
  priorState:await s.pin('continued-state.json',state),priorLedger:await s.pin('continued-ledger.jsonl',await fs.readFile(s.filename,'utf8')),completed:[],failed:[],ancestors:[parent],
  stop:await s.pin('actual-interrupt.json',{purpose:'phase-c-actual-auth-stop-observation',window,observedAtUtc:new Date(now-2000).toISOString(),reason:'OWNER_WORKOS_SIGNIN_POLICY_FAILURE',interruptSent:true,observedExitCode:1,ownedHermesProcessesPresent:0,cleanupVerified:false,gateComplete:false}),
  localHostStop:await s.pin('actual-host-stop.json',postExpiry?{purpose:'post-window-actual-readonly-readiness',checkedAtUtc:new Date(now-1000).toISOString(),originalHardStopUtc:receipt.hardStopUtc,originalWindowExpired:true,authRefreshes:0,tasksSent:0,hostsStarted:0,modelsAdded:0,claimsIssued:0,
   profiles:['je1','je2','testowner'].map(role=>({role,gatewayReachable:false,code:'HERMES_DAEMON_UNREACHABLE'})),gateComplete:false}:{purpose:'phase-c-local-post-interrupt-host-observation',checkedAtUtc:new Date(now-1000).toISOString(),readOnly:true,modelsAdded:0,claimsIssued:0,
   hosts:['je1','je2','testowner'].map(role=>({role,stopped:true,code:'HERMES_DAEMON_UNREACHABLE'})),allSelectedHermesUnreachable:true,fullCleanupVerified:false})};
 const inventory=JSON.parse(await fs.readFile(parent.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();recovery.currentInventory=await s.pin('next-inventory.json',inventory);
 let nextReceipt={...receipt,clientSource:'e'.repeat(40),ciHead:'e'.repeat(40),packetSha256:h('third packet'),runnerSha256:h('third library'),startUtc:new Date(now-100).toISOString(),hardStopUtc:new Date(now+120000).toISOString()};
 const decisionId='inert-third-run-decision',decision=await s.pin('third-time.json',{purpose:'phase-c-explicit-new-recovery-interval',version:1,owner:'pjsk02',ownerApproved:true,
  clientSource:nextReceipt.clientSource,serverSource:nextReceipt.serverSource,runnerSha256:nextReceipt.runnerSha256,packetSha256:nextReceipt.packetSha256,priorWindow:window,priorPacketSha256:packet.sha256,priorStateSha256:recovery.priorState.sha256,priorProgramSha256:state.planSha256,
  modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:35,currentOperations:32,currentCanonicalMessages:12,repeatOnboarding:false,replayAcceptedSends:false,pauseFailureWaived:false,decisionId,receivedAtUtc:new Date(now-200).toISOString(),maximumIntervalMs:5400000});
 const amendment=await s.pin('third-approval.json',{recovery:{timeMode:'new-interval',timeDecisionSha256:decision.sha256,timeDecisionId:decisionId}});nextReceipt={...nextReceipt,approvalReceiptSha256:amendment.sha256};
 recovery.time={mode:'new-interval',decisionPath:decision.path,decisionSha256:decision.sha256,amendmentPath:amendment.path};const nextSigned=s.sign(s.nextGraph,nextReceipt,'third actual-format');
 const options={...s.options,receipt:nextReceipt,expected:{...s.options.expected,clientSource:nextReceipt.clientSource,runnerSha256:nextReceipt.runnerSha256,packetSha256:nextReceipt.packetSha256},preflight:{...s.options.preflight,checkedAtMs:now},reviewedPlan:nextSigned.plan,graphApprovalRaw:nextSigned.raw,recovery};
 return{...s,options,parent,state,window};
}
async function preProgramSetup(){
 const s=await setup(),directory=path.join(s.root,'session');await fs.mkdir(directory);const programDirectory=path.join(directory,'native-program');await fs.mkdir(programDirectory);
 const p=s.options.recovery,{actionLedger,currentInventory,time,...historical}=p,historyPin=await s.pin('restore-history.json',historical),journals=[];
 const states={je1:path.join(s.root,'je1'),je2:path.join(s.root,'je2'),testowner:path.join(s.root,'testowner')};
 for(const role of ['je1','je2','testowner'] as const){await fs.mkdir(path.join(states[role],'scoped-runs'),{recursive:true});for(let i=0;i<3;i++){const file=`journal-${i}.json`,bytes=JSON.stringify({inert:true,role,i});await fs.writeFile(path.join(states[role],'scoped-runs',file),bytes);journals.push({role,file,sha256:hash(bytes)});}}
 const packet=await s.pin('restore-packet.json',{purpose:'phase-c-prepared-stopped-progress-session',version:1,directory,states,program:{originalJournalHashes:journals},resumption:{history:historyPin},
  clientSource:s.options.receipt.clientSource,serverSource:s.options.receipt.serverSource,oldKitRoot:s.root,library:{sha256:s.options.receipt.runnerSha256},
  historyPins:{priorExecution:p.priorExecution,priorPacket:p.priorPacket,priorState:p.priorState,priorLedger:p.priorLedger,stop:p.stop,completed:p.completed,failed:p.failed}});
 const receipt={...s.options.receipt,packetSha256:packet.sha256},signed=s.sign(s.nextGraph,receipt,'preprogram'),options={...s.options,receipt,
  expected:{...s.options.expected,packetSha256:packet.sha256},reviewedPlan:signed.plan,graphApprovalRaw:signed.raw};
 const controller=await ContinuationController.startStoppedProgress(await ContinuationController.prepareStoppedProgress(options));controller.stop();
 const window=hash(JSON.stringify(receipt)),source='f'.repeat(40),runnerSha256=h('restore implementation');
 const stop={state:'operator_stopped_no_further_task_release',packetSha256:packet.sha256,observedAtUtc:new Date().toISOString(),gateComplete:false};
 const local={purpose:'actual-v2-poststop-readonly-observation',source:receipt.clientSource,operatorStop:stop,window,checkedAtUtc:new Date().toISOString(),modelsAdded:0,chargedAttempts:35,pending:0,unresolvedDispatches:0,
  conservativeOperations:32,assets:0,emptyNativeProgramDirectoryObserved:true,conductorStateCreated:false,
  selectedHermesStopped:['je1','je2','testowner'].map(role=>({role,selectedCanonicalPipeUnavailable:true})),originalJournalHashesVerified:journals.map(j=>({...j,originalHashMatches:true}))};
 const restore={execution:await s.pin('restore-execution.json',{receipt,window,approvalSha256:receipt.approvalReceiptSha256,graphApprovalRaw:signed.raw}),packet,
  operatorStop:await s.pin('restore-stop.json',stop),
  localStop:await s.pin('restore-local.json',local),ledgerAtStop:await s.pin('restore-ledger.jsonl',await fs.readFile(s.filename,'utf8')),programDirectory,
  implementation:{source,runnerSha256,approval:await s.pin('restore-approval.json',{purpose:'phase-c-same-window-preprogram-restoration',ownerApproved:true,window,
   startUtc:receipt.startUtc,hardStopUtc:receipt.hardStopUtc,originalClientSource:receipt.clientSource,originalPacketSha256:packet.sha256,
   recoverySource:source,recoveryRunnerSha256:runnerSha256,ciHead:source,ciPassed:true,modelCap:64,newInterval:false})}};
 return{...s,options:{...options,restore},local,window};
}
it('restores a real empty pre-program run once with the original clock and complete replay fences, without changing the ledger',async()=>{
 const s=await preProgramSetup(),before=await fs.readFile(s.filename),handle=await ContinuationController.preparePreProgramRestore(s.options);
 expect(await fs.readFile(s.filename)).toEqual(before);const c=await ContinuationController.startPreProgramRestore(handle);
 expect(c.receipt).toEqual(s.options.receipt);expect(c.summary().budget.chargedAttempts).toBe(35);
 for(const id of s.used)expect(()=>c.releaseGroup([id])).toThrow();
 c.releaseGroup(['new-private-review']);expect(()=>c.expectWork('new-private-review','msg_private-followup',h('evidence'))).toThrow('PRIOR_NATIVE_WORK_MUST_NOT_REPEAT');
 expect(await fs.readFile(s.filename)).toEqual(before);c.stop();
 await expect(ContinuationController.startPreProgramRestore(handle)).rejects.toThrow('PREPARED_PREPROGRAM_RESTORE_REQUIRED');
 const next=await ContinuationController.preparePreProgramRestore(s.options);await expect(ContinuationController.startPreProgramRestore(next)).rejects.toThrow();
});
it.each(['native-history','program-file','foreign-directory','reachable','journal-changed','late-stop','new-clock','wrong-implementation','dropped-history','ledger-change','foreign-root','stale-local','unrelated-stop','missing-journal'] as const)('refuses unsafe pre-program restoration: %s',async fault=>{
 const s=await preProgramSetup(),o=s.options,r=o.restore;
 if(fault==='native-history'){const l=await RequestBudgetLedger.open(s.filename);await l.bindWork('new-private-review',{canonicalWorkHash:h('msg_added'),nativeToken:h('token'),evidenceHash:h('evidence')});r.ledgerAtStop=await s.pin('changed-ledger.jsonl',await fs.readFile(s.filename,'utf8'));}
 if(fault==='program-file')await fs.writeFile(path.join(r.programDirectory,'state.json'),'{}');
 if(fault==='foreign-directory'){r.programDirectory=path.join(s.root,'foreign');await fs.mkdir(r.programDirectory);}
 if(fault==='reachable'){s.local.selectedHermesStopped[0].selectedCanonicalPipeUnavailable=false;r.localStop=await s.pin('bad-local.json',s.local);}
 if(fault==='journal-changed'){s.local.originalJournalHashesVerified[0].originalHashMatches=false;r.localStop=await s.pin('bad-local.json',s.local);}
 if(fault==='late-stop'){r.operatorStop=await s.pin('late-stop.json',{state:'operator_stopped_no_further_task_release',packetSha256:r.packet.sha256,observedAtUtc:new Date(Date.now()+60000).toISOString()});}
 if(fault==='new-clock')o.receipt={...o.receipt,hardStopUtc:new Date(Date.parse(o.receipt.hardStopUtc)+1).toISOString()};
 if(fault==='wrong-implementation')r.implementation.source='1'.repeat(40);
 if(fault==='dropped-history')o.recovery={...o.recovery,failed:[]};
 if(fault==='ledger-change')await fs.appendFile(r.ledgerAtStop.path,' ');
 if(fault==='foreign-root'){const clone=path.join(s.root,'clone');await fs.mkdir(clone);for(const name of await fs.readdir(s.root)){const stat=await fs.lstat(path.join(s.root,name));if(stat.isFile())await fs.copyFile(path.join(s.root,name),path.join(clone,name));}o.releaseRoot=clone;}
 if(fault==='stale-local'){s.local.checkedAtUtc=new Date(Date.now()-300001).toISOString();r.localStop=await s.pin('bad-local.json',s.local);}
 if(fault==='unrelated-stop'){s.local.operatorStop={...s.local.operatorStop,observedAtUtc:new Date(Date.parse(s.local.operatorStop.observedAtUtc)-1).toISOString()};r.localStop=await s.pin('bad-local.json',s.local);}
 if(fault==='missing-journal'){s.local.originalJournalHashesVerified.pop();r.localStop=await s.pin('bad-local.json',s.local);}
 const before=await fs.readFile(s.filename);await expect(ContinuationController.preparePreProgramRestore(o)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});
it('rechecks pins and freshness after preparation before consuming restoration',async()=>{
 const s=await preProgramSetup(),handle=await ContinuationController.preparePreProgramRestore(s.options);await fs.appendFile(s.options.restore.operatorStop.path,' ');
 await expect(ContinuationController.startPreProgramRestore(handle)).rejects.toThrow('STOPPED_PROGRESS_EVIDENCE_CHANGED');
});
async function newPreProgramInterval(){
 const s=await preProgramSetup(),o=s.options,r=o.restore,now=Date.parse(o.receipt.hardStopUtc)+1000;vi.spyOn(Date,'now').mockReturnValue(now);
 const inventory=JSON.parse(await fs.readFile(o.recovery.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();o.preflight.checkedAtMs=now;o.recovery.currentInventory=await s.pin('fresh-new-inventory.json',inventory);
 s.local.checkedAtUtc=new Date(now).toISOString();r.localStop=await s.pin('fresh-new-hosts.json',s.local);
 const approval=JSON.parse(await fs.readFile(r.implementation.approval.path,'utf8'));approval.newInterval=true;r.implementation.approval=await s.pin('new-implementation-approval.json',approval);
 const d={purpose:'phase-c-explicit-new-preprogram-interval',version:1,owner:'pjsk02',ownerApproved:true,priorWindow:s.window,
  originalExecutionSha256:r.execution.sha256,originalStopSha256:r.operatorStop.sha256,originalPacketSha256:o.receipt.packetSha256,
  originalClientSource:o.receipt.clientSource,serverSource:o.receipt.serverSource,originalRunnerSha256:o.receipt.runnerSha256,
  recoverySource:r.implementation.source,recoveryRunnerSha256:r.implementation.runnerSha256,modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,
  currentModels:35,currentOperations:32,currentCanonicalMessages:12,currentCases:4,currentAssets:0,repeatOnboarding:false,replayAcceptedSends:false,
  decisionId:'inert-new-preprogram-decision',receivedAtUtc:new Date(now-1000).toISOString(),maximumIntervalMs:5400000};
 const timeDecision=await s.pin('new-preprogram-decision.json',d),receipt={...o.receipt,approvalReceiptSha256:timeDecision.sha256,startUtc:new Date(now).toISOString(),hardStopUtc:new Date(now+5400000).toISOString()},signed=s.sign(s.nextGraph,receipt,'new preprogram interval');
 return{...s,decision:d,options:{...o,restore:{...r,next:{receipt,graphApprovalRaw:signed.raw,timeDecision}}}};
}
it('uses one genuinely new time decision after an expired pre-program run, preserving original receipts and counts',async()=>{
 const s=await newPreProgramInterval(),before=await fs.readFile(s.filename),old=await fs.readFile(s.options.restore.execution.path),handle=await ContinuationController.preparePreProgramRestore(s.options);
 expect(await fs.readFile(s.filename)).toEqual(before);const c=await ContinuationController.startPreProgramRestore(handle);
 expect(c.receipt).toEqual(s.options.restore.next.receipt);expect(c.ledger.snapshot().chargedAttempts).toBe(35);
 expect((await fs.readFile(s.filename)).subarray(0,before.length)).toEqual(before);expect(await fs.readFile(s.options.restore.execution.path)).toEqual(old);
 for(const id of s.used)expect(()=>c.releaseGroup([id])).toThrow();c.stop();
 const decisionFile=(await fs.readdir(s.root)).find(f=>f.startsWith('phase-c-recovery-time-'));expect(decisionFile).toBeTruthy();
 await expect(authorizePreProgramInterval({...s.options,ledger:c.ledger})).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');
 const reencoded=await s.pin('same-decision-reencoded.json',JSON.stringify(s.decision,null,2));
 s.options.restore.next.timeDecision=reencoded;s.options.restore.next.receipt.approvalReceiptSha256=reencoded.sha256;
 await expect(authorizePreProgramInterval({...s.options,ledger:c.ledger})).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');
 await expect(ContinuationController.preparePreProgramRestore(s.options)).rejects.toThrow();
});
it.each(['no-time-decision','wrong-stop','cap-reset','extra-time','new-runtime','changed-graph','unsigned-interval','decision-after-start'] as const)('refuses new pre-program time with %s before any metadata write',async fault=>{
 const s=await newPreProgramInterval(),o=s.options,n=o.restore.next;
 if(fault==='no-time-decision')n.timeDecision={...n.timeDecision,sha256:h('absent decision')};
 if(fault==='wrong-stop')s.decision.originalStopSha256=h('other stopped run');
 if(fault==='cap-reset')s.decision.currentModels=30;
 if(fault==='extra-time')n.receipt.hardStopUtc=new Date(Date.parse(n.receipt.startUtc)+5400001).toISOString();
 if(fault==='new-runtime')n.receipt.clientSource='2'.repeat(40);
 if(fault==='changed-graph')n.graphApprovalRaw=JSON.stringify({...JSON.parse(n.graphApprovalRaw),planSha256:h('different graph')});
 if(fault==='unsigned-interval'){const a=JSON.parse(await fs.readFile(o.restore.implementation.approval.path,'utf8'));a.newInterval=false;o.restore.implementation.approval=await s.pin('unsigned-interval.json',a);}
 if(fault==='decision-after-start')s.decision.receivedAtUtc=new Date(Date.parse(n.receipt.startUtc)+1).toISOString();
 if(['wrong-stop','cap-reset','decision-after-start'].includes(fault)){n.timeDecision=await s.pin('wrong-time.json',s.decision);n.receipt.approvalReceiptSha256=n.timeDecision.sha256;n.graphApprovalRaw=s.sign(s.nextGraph,n.receipt,'wrong signed time').raw;}
 const before=await fs.readFile(s.filename);await expect(ContinuationController.preparePreProgramRestore(o)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});
it('reads actual stopped-progress packet/execution formats and verifies ancestral outcomes without replay',async()=>{
 const s=await secondGeneration(),before=await fs.readFile(s.filename),journal=await fs.readFile(s.parent.failed[0].journal.path);
 const prepared=await ContinuationController.prepareStoppedProgress(s.options);expect(prepared).toMatchObject({currentModels:35,priorWindow:s.window});expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startStoppedProgress(prepared);for(const flow of s.used)expect(()=>c.releaseGroup([flow])).toThrow();
 expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:35,knownDispatchedRequests:5,pending:0,unresolvedDispatches:0});expect(await fs.readFile(s.parent.failed[0].journal.path)).toEqual(journal);c.stop();
});
it('accepts the actual post-expiry observation without treating it as complete cleanup or a new time decision',async()=>{
 const s=await secondGeneration(true),before=await fs.readFile(s.filename),result=await ContinuationController.prepareStoppedProgress(s.options);
 expect(result.currentModels).toBe(35);expect(await fs.readFile(s.filename)).toEqual(before);
});
it.each(['wrong-deadline','not-expired','early-check','reachable','added-model','added-send'] as const)('refuses post-expiry evidence with %s',async fault=>{
 const s=await secondGeneration(true),r=s.options.recovery,local=JSON.parse(await fs.readFile(r.localHostStop.path,'utf8'));
 if(fault==='wrong-deadline')local.originalHardStopUtc=new Date(Date.now()).toISOString();
 if(fault==='not-expired')local.originalWindowExpired=false;
 if(fault==='early-check')local.checkedAtUtc=new Date(Date.parse(local.originalHardStopUtc)-1).toISOString();
 if(fault==='reachable')local.profiles[0].gatewayReachable=true;
 if(fault==='added-model')local.modelsAdded=1;
 if(fault==='added-send')local.tasksSent=1;
 r.localHostStop=await s.pin('invalid-post-expiry.json',local);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('PRIOR_PROGRESS_STOP_REQUIRED');
});
it('refuses dropped or changed ancestry even when the latest run has no native starts',async()=>{
 const s=await secondGeneration(),before=await fs.readFile(s.filename);
 await expect(ContinuationController.prepareStoppedProgress({...s.options,recovery:{...s.options.recovery,ancestors:[]}})).rejects.toThrow('EXACT_PROGRESS_ANCESTRY_REQUIRED');
 await fs.appendFile(s.parent.completed[0].nativeTerminal.path,' ');
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('STOPPED_PROGRESS_EVIDENCE_CHANGED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it.each(['nativeTerminal','canonicalSnapshot'] as const)('rejects re-pinned ancestral %s substitution against the immutable carried failed-proof digest',async field=>{
 const s=await secondGeneration(),before=await fs.readFile(s.filename),p=s.parent.failed[0],value=JSON.parse(await fs.readFile(p[field].path,'utf8'));
 if(field==='nativeTerminal')value.result.outcome='cancelled';else value.messages[0].text='substituted canonical content';
 p[field]=await s.pin('substituted-'+field+'.json',value);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('EXACT_PROGRESS_ANCESTRY_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it.each(['packetSha256','graphApproval','approvalSha256','graphApprovalRaw'] as const)('refuses conflicting actual execution %s aliases before any write',async field=>{
 const s=await secondGeneration(),before=await fs.readFile(s.filename),value=JSON.parse(await fs.readFile(s.options.recovery.priorExecution.path,'utf8'));
 value[field]=field==='graphApproval'?{invented:true}:h('conflicting execution alias');s.options.recovery.priorExecution=await s.pin('ambiguous-execution.json',value);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow(field.includes('graph')?'ORIGINAL_PROGRESS_GRAPH_REQUIRED':'ORIGINAL_PROGRESS_PROVENANCE_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it.each(['missing-local','present-process','live-endpoint','wrong-window','future-observation','duplicate-host'] as const)('refuses interrupted stop with %s evidence',async fault=>{
 const s=await secondGeneration(),before=await fs.readFile(s.filename),r=s.options.recovery,stop=JSON.parse(await fs.readFile(r.stop.path,'utf8')),local=JSON.parse(await fs.readFile(r.localHostStop.path,'utf8'));
 if(fault==='missing-local')delete r.localHostStop;
 if(fault==='present-process')stop.ownedHermesProcessesPresent=1;
 if(fault==='wrong-window')stop.window=h('other window');
 if(fault==='future-observation')stop.observedAtUtc=new Date(Date.now()+1).toISOString();
 if(fault==='live-endpoint')local.hosts[0].stopped=false;
 if(fault==='duplicate-host')local.hosts[1]=local.hosts[0];
 r.stop=await s.pin('invalid-stop.json',stop);if(r.localHostStop)r.localHostStop=await s.pin('invalid-host-stop.json',local);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('PRIOR_PROGRESS_STOP_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it('history inspection verifies actual formats without manufacturing new approval, time or a preparation handle',async()=>{
 const s=await secondGeneration(),r=s.options.recovery,ledger=await RequestBudgetLedger.open(s.filename);
 const snapshot=async()=>{const names=(await fs.readdir(s.root)).sort();return Promise.all(names.map(async n=>[n,hash(await fs.readFile(path.join(s.root,n)))]));};
 const before=await snapshot(),proof=await inspectStoppedProgressHistory({releaseRoot:s.root,recovery:r,ledger});
 expect(proof.priorWindow).toBe(s.window);expect(proof.blockedFlows).toEqual(expect.arrayContaining(s.used));expect(await snapshot()).toEqual(before);
 await expect(ContinuationController.startStoppedProgress(proof as any)).rejects.toThrow('PREPARED_STOPPED_PROGRESS_REQUIRED');
 const prior=JSON.parse(await fs.readFile(r.priorExecution.path,'utf8')).receipt;vi.spyOn(Date,'now').mockReturnValue(Date.parse(prior.hardStopUtc)-1);
 await expect(inspectStoppedProgressHistory({releaseRoot:s.root,recovery:r,ledger})).rejects.toThrow('PRIOR_PROGRESS_STOP_REQUIRED');
});
it('requires the current complete prefix, exact ancestral prefix, and bounded acyclic ancestry',async()=>{
 const s=await secondGeneration(),r=s.options.recovery,before=await fs.readFile(s.filename);
 await expect(ContinuationController.prepareStoppedProgress({...s.options,recovery:{...r,priorLedger:s.parent.priorLedger}})).rejects.toThrow('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
 await expect(ContinuationController.prepareStoppedProgress({...s.options,recovery:{...r,ancestors:Array(9).fill(s.parent)}})).rejects.toThrow('EXACT_PROGRESS_ANCESTRY_REQUIRED');
 const parent={...s.parent,priorLedger:await s.pin('short-parent-prefix.jsonl',s.prefix.slice(0,-1))};
 await expect(ContinuationController.prepareStoppedProgress({...s.options,recovery:{...r,ancestors:[parent]}})).rejects.toThrow('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it('does not lose ancestor results when a new stopped state has an empty results map',async()=>{
 const s=await secondGeneration(),r=s.options.recovery,state=JSON.parse(await fs.readFile(r.priorState.path,'utf8'));delete state.carriedProgress.completedResults['private-followup'];
 r.priorState=await s.pin('dropped-carried-outcome.json',state);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('EXACT_PROGRESS_ANCESTRY_REQUIRED');
});
it('does not hide a binding in the latest empty native state',async()=>{
 const s=await secondGeneration(),ledger=await RequestBudgetLedger.open(s.filename);await ledger.bindWork('new-private-review',{canonicalWorkHash:h('msg_new_hidden'),nativeToken:h('hidden token'),evidenceHash:h('hidden evidence')});
 s.options.recovery.priorLedger=await s.pin('latest-hidden-binding.jsonl',await fs.readFile(s.filename,'utf8'));
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('PRIOR_NATIVE_WORK_NOT_RECONCILED');
});
it('prepares without mutation, starts with all35 charges, preserves old outcomes and blocks replay',async()=>{
 const s=await setup(),before=await fs.readFile(s.filename),failedBefore=await fs.readFile(s.options.recovery.failed[0].journal.path);
 const prepared=await ContinuationController.prepareStoppedProgress(s.options);expect(prepared.currentModels).toBe(35);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startStoppedProgress(prepared);expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:35,remainingModelAttempts:29,pending:0,unresolvedDispatches:0,knownDispatchedRequests:5});
 expect((await fs.readFile(s.filename)).subarray(0,before.length)).toEqual(before);expect(await fs.readFile(s.options.recovery.failed[0].journal.path)).toEqual(failedBefore);
 expect(JSON.parse(failedBefore.toString()).completed).toBe(false);
 for(const id of s.used)expect(()=>c.releaseGroup([id])).toThrow();
 expect(()=>c.releaseGroup(['green'])).toThrow();
 c.releaseGroup(['new-private-review']);expect(()=>c.expectWork('new-private-review','msg_private-receipt-review',h('causal'))).toThrow('PRIOR_NATIVE_WORK_MUST_NOT_REPEAT');
 c.expectWork('new-private-review','msg_genuinely_new_review',h('causal'));
 await expect(c.ledger.bindWork('green',{canonicalWorkHash:h('new'),nativeToken:h('new token'),evidenceHash:h('evidence')})).rejects.toThrow('CANONICAL_WORK_BINDING_REQUIRED');
 await expect(c.ledger.selectPhase('hermes',['green'],Date.now()+10000)).rejects.toThrow('HOST_PHASE_REFUSED');
 await expect(ContinuationController.startStoppedProgress(prepared)).rejects.toThrow('PREPARED_STOPPED_PROGRESS_REQUIRED');c.stop();
});
it.each(['journal','nativeTerminal','canonicalSnapshot'] as const)('refuses changed prior failed %s evidence before any mutation',async field=>{
 const s=await setup(),before=await fs.readFile(s.filename),p=s.options.recovery.failed[0][field];await fs.appendFile(p.path,' ');
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('STOPPED_PROGRESS_EVIDENCE_CHANGED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it('requires every started and durable binding even if the conductor entry was removed',async()=>{
 const s=await setup();delete s.state.started['private-receipt-review'];s.options.recovery.priorState=await s.pin('old-state.json',s.state);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('PRIOR_NATIVE_WORK_NOT_RECONCILED');
});
it('refuses stale or reset counts, pending dispatches, and unseen ledger suffixes',async()=>{
 const s=await setup();
 for(const preflight of [{...s.options.preflight,actualHermesCalls:24},{...s.options.preflight,checkedAtMs:Date.now()-300001},{...s.options.preflight,conservativeMessages:21}])await expect(ContinuationController.prepareStoppedProgress({...s.options,preflight})).rejects.toThrow('FRESH_STOPPED_PROGRESS_PREFLIGHT_REQUIRED');
 const prepared=await ContinuationController.prepareStoppedProgress(s.options);await s.original.ledger.bindWork('accept-authority',{canonicalWorkHash:h('msg_another'),nativeToken:h('another token'),evidenceHash:h('another evidence')});
 await expect(ContinuationController.startStoppedProgress(prepared)).rejects.toThrow('EXACT_STOPPED_LEDGER_PREFIX_REQUIRED');
});
it('does not retire an allocated flow after even a binding-only admission',async()=>{
 const s=await setup();await s.original.ledger.bindWork('green',{canonicalWorkHash:h('green old work'),nativeToken:h('green old token'),evidenceHash:h('green old evidence')});
 const signed=s.sign(s.nextGraph,s.options.receipt,'binding retired');
 expect(()=>s.original.ledger.inspectReviewedPlanAmendment(signed.plan,s.proof(s.options.receipt,signed.raw,35))).toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
});
it('does not reduce an existing quota or change executed program provenance to make room',async()=>{
 const s=await setup(),graph={...s.nextGraph,flows:s.nextGraph.flows.map(f=>f.id==='accept-authority'?{...f,requests:1}:f)},signed=s.sign(graph,s.options.receipt,'quota reduction');
 await expect(ContinuationController.prepareStoppedProgress({...s.options,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw})).rejects.toThrow('STOPPED_PROGRESS_QUOTAS_MUST_BE_PRESERVED');
 s.state.planSha256=h('invented program');s.options.recovery.priorState=await s.pin('old-state.json',s.state);
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('ORIGINAL_PROGRESS_PROVENANCE_REQUIRED');
});
it('pins actual action accounting and current canonical effects instead of accepting smaller counters',async()=>{
 const s=await setup();
 await expect(ContinuationController.prepareStoppedProgress({...s.options,preflight:{...s.options.preflight,conservativeMessages:24}})).rejects.toThrow('CURRENT_ACTION_ACCOUNTING_REQUIRED');
 await expect(ContinuationController.prepareStoppedProgress({...s.options,preflight:{...s.options.preflight,canonicalEffects:11}})).rejects.toThrow('CURRENT_CANONICAL_PROGRESS_INVENTORY_REQUIRED');
});
it('rejects unretirement and validates late retired history on reopen',async()=>{
 const s=await setup(),c=await ContinuationController.startStoppedProgress(await ContinuationController.prepareStoppedProgress(s.options));
 const graph={...s.nextGraph,flows:s.nextGraph.flows.map(f=>{const{retired,...rest}=f;return f.id==='green'?rest:f;})},signed=s.sign(graph,s.options.receipt,'unretire');
 await expect(c.ledger.amendReviewedPlan(signed.plan,s.proof(s.options.receipt,signed.raw,35))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
 const raw=await fs.readFile(s.filename,'utf8'),previous=hash(raw.trimEnd().split('\n').at(-1)!+'\n');
 await fs.appendFile(s.filename,JSON.stringify({previous,kind:'binding',window:c.ledger.window,flow:'green',role:'je1',canonicalWorkHash:h('late'),nativeToken:h('late token'),evidenceHash:h('late evidence')})+'\n');
 await expect(RequestBudgetLedger.open(s.filename)).rejects.toThrow('RETIRED_FLOW_HAS_NATIVE_HISTORY');c.stop();
});
it('keeps cumulative cap accounting at64 without subtracting used requests twice',async()=>{
 const s=await setup();
 for(const requests of [4,3]){const graph={...s.nextGraph,flows:s.nextGraph.flows.map(f=>f.id==='new-private-review'?{...f,requests}:f)},signed=s.sign(graph,s.options.receipt,'cap '+requests),input={...s.options,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw};
  if(requests===4)await expect(ContinuationController.prepareStoppedProgress(input)).rejects.toThrow('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');else expect((await ContinuationController.prepareStoppedProgress(input)).currentModels).toBe(35);
 }
});
it('requires genuine negative native and canonical failure, never an unfinished or successful prior receipt',async()=>{
 const s=await setup(),p=s.options.recovery.failed[0];
 for(const outcome of ['completed','unknown']){p.nativeTerminal=await s.pin('failed-terminal.json',{status:outcome==='unknown'?'started':'terminal',outcome,ref:{session_id:'session_private-receipt-review'},admission_id:'admission_private-receipt-review'});await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('GENUINE_PRIOR_NATIVE_TERMINAL_REQUIRED');}
});
it('binds prior terminal evidence to the original input identity before any progress mutation',async()=>{
 const s=await setup(),p=s.options.recovery.failed[0],before=await fs.readFile(s.filename);
 p.nativeTerminal=await s.pin('wrong-input-terminal.json',{status:'terminal',outcome:'interrupted',ref:{session_id:'session_private-receipt-review'},admission_id:'admission_private-receipt-review',input_id:'foreign-input'});
 await expect(ContinuationController.prepareStoppedProgress(s.options)).rejects.toThrow('GENUINE_PRIOR_NATIVE_TERMINAL_REQUIRED');
 expect(await fs.readFile(s.filename)).toEqual(before);
});
it('refuses expired time or forged preparation handles without modifying the ledger',async()=>{
 const s=await setup(),before=await fs.readFile(s.filename);
 await expect(ContinuationController.prepareStoppedProgress({...s.options,receipt:{...s.options.receipt,hardStopUtc:new Date(Date.now()-1).toISOString()}})).rejects.toThrow('FRESH_EXACT_CONTINUATION_APPROVAL_REQUIRED');
 await expect(ContinuationController.startStoppedProgress({kind:'verified-stopped-progress',currentModels:35,window:h('fake'),priorWindow:h('old'),ledgerSha256:h('fake ledger')})).rejects.toThrow('PREPARED_STOPPED_PROGRESS_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});
it('binds a new one-use time decision to current35/32/12 without consuming it during preparation',async()=>{
 const s=await setup(),old=JSON.parse(await fs.readFile(s.options.recovery.priorExecution.path,'utf8')).receipt;
 const decisionId='inert-post-progress-time-decision',decision={purpose:'phase-c-explicit-new-recovery-interval',version:1,owner:'pjsk02',ownerApproved:true,
  clientSource:s.options.receipt.clientSource,serverSource:s.options.receipt.serverSource,runnerSha256:s.options.receipt.runnerSha256,packetSha256:s.options.receipt.packetSha256,
  priorWindow:s.original.ledger.window,priorPacketSha256:old.packetSha256,priorStateSha256:s.options.recovery.priorState.sha256,priorProgramSha256:s.state.planSha256,
  modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:35,currentOperations:32,currentCanonicalMessages:12,
  repeatOnboarding:false,replayAcceptedSends:false,pauseFailureWaived:false,decisionId,receivedAtUtc:new Date(Date.now()-1500).toISOString(),maximumIntervalMs:5400000};
 const d=await s.pin('new-time.json',decision),a=await s.pin('new-approval.json',{recovery:{timeMode:'new-interval',timeDecisionSha256:d.sha256,timeDecisionId:decisionId}});
 const receipt={...s.options.receipt,approvalReceiptSha256:a.sha256,startUtc:new Date(Date.now()-500).toISOString(),hardStopUtc:new Date(Date.now()+180000).toISOString()},signed=s.sign(s.nextGraph,receipt,'new time'),time={mode:'new-interval' as const,decisionPath:d.path,decisionSha256:d.sha256,amendmentPath:a.path};
 const input={...s.options,receipt,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw,recovery:{...s.options.recovery,time}},marker=path.join(s.root,'phase-c-recovery-time-'+hash('pjsk02\0'+decisionId)+'.used.json');
 const prepared=await ContinuationController.prepareStoppedProgress(input);await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});
 const c=await ContinuationController.startStoppedProgress(prepared);expect(JSON.parse(await fs.readFile(marker,'utf8')).decisionId).toBe(decisionId);expect(c.ledger.snapshot().chargedAttempts).toBe(35);
 await expect(authorizeRecoveryTime({link:time,original:old,receipt,priorWindow:decision.priorWindow,priorPacketSha256:old.packetSha256,stateSha256:decision.priorStateSha256,programSha256:s.state.planSha256,amendmentSha256:a.sha256,releaseRoot:s.root,currentAccounting:{models:35,operations:32,canonicalMessages:12}})).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');c.stop();
});

// Actual post-control shape with inert identities, files and zero network activity.
async function controlledSetup(){
 const s=await secondGeneration(true),r:any=s.options.recovery,t0=Date.now(),now=t0+1200000;
 vi.spyOn(Date,'now').mockReturnValue(now);
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const workId='msg_retained_shared',caseId=s.options.flowCases.openclaw,agentId=s.options.actorIds.openclaw;
 s.state.taskReceipts.shared={state:'accepted',messageId:workId,caseId};r.priorState=await s.pin('ancestor-with-shared.json',s.state);
 const states:any={},journals:any[]=[];
 for(const role of ['je1','je2','testowner','openclaw']){states[role]=path.join(s.root,role);await fs.mkdir(path.join(states[role],'scoped-runs'),{recursive:true});
  if(role!=='openclaw')for(let i=0;i<3;i++){const file='original-'+i+'.json',j=await s.pin('journal-'+role+i,JSON.stringify({role,i,inert:true}));await fs.copyFile(j.path,path.join(states[role],'scoped-runs',file));journals.push({role,file,sha256:j.sha256});}}
 const {actionLedger,currentInventory,time,...ancestry}=r,history=await s.pin('control-history.json',ancestry);
 const program={originalJournalHashes:journals,windowId:'unstarted'},actors={...s.options.actorIds,openclaw:{agentId,installationId:'installation_inert'}};
 const packet:any={clientSource:s.options.receipt.clientSource,serverSource:s.options.receipt.serverSource,library:{sha256:s.options.receipt.runnerSha256},oldKitRoot:s.root,states,actors,program,resumption:{history}};
 const packetPin=await s.pin('control-runtime.json',packet),ledger=await RequestBudgetLedger.open(s.filename);
 const executions:any[]=[];
 for(let i=0;i<2;i++){const receipt={...s.options.receipt,packetSha256:packetPin.sha256,startUtc:new Date(t0+i*100).toISOString(),hardStopUtc:new Date(t0+5400000+i*100).toISOString()},signed=s.sign(s.nextGraph,receipt,'controlled-'+i),window=hash(JSON.stringify(receipt));
  await ledger.bindApprovedWindow(window,{approvalReceiptHash:receipt.approvalReceiptSha256,allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:35});await ledger.amendReviewedPlan(signed.plan,s.proof(receipt,signed.raw,35));
  executions.push({receipt,window,approvalSha256:receipt.approvalReceiptSha256,graphApprovalRaw:signed.raw});}
 const [first,current]=executions;current.original=first;
 const operator=await s.pin('control-operator.json',{original:{packet:packetPin},recovery:{source:'f'.repeat(40),library:{sha256:h('recovery library')}}});
 const seal=await s.pin('control-seal.json',{original:{packet:packetPin},packet:operator});current.sealSha256=seal.sha256;current.recoveryImplementation={source:'f'.repeat(40),library:{sha256:h('recovery library')}};
 const stop=await s.pin('control-stopped.json',{packetSha256:operator.sha256,phase:'remaining-native-program',gateComplete:false,observedAtUtc:new Date(now-100).toISOString()});
 const controls:any={},controlPins:any={};
 for(const mode of ['pause','expiry']){const fence=mode==='pause'?2:3,session={id:'scope_'+mode,fence,agentId,installationId:'installation_inert',createdAt:new Date(t0+1000).toISOString(),expiresAt:new Date(t0+901000).toISOString()};
  const scope=await s.pin(mode+'-scope.json',{window:current.window,workId,caseId,session});
  const actions=[];
  if(mode==='pause')for(const action of ['pause','resume']){const receipt={window:current.window,humanConfirmed:true,agentId,installationId:'installation_inert',action};const pin=await s.pin(action+'-owner.json',receipt);actions.push({receiptPath:pin.path,sha256:pin.sha256,receipt});}
  const probes=mode==='pause'?[{stage:'paused',settlement:{code:'AGENT_PAUSED',status:{raw:JSON.stringify({state:'paused'})}}},{stage:'resumed',settlement:{code:'WORK_LEASE_STALE',status:{raw:JSON.stringify({state:'active'})}}}]:[{stage:'expired',scope:{code:'CASE_SESSION_EXPIRED'},settlement:{code:'WORK_LEASE_STALE'},frozenLeaseExpiresAt:new Date(t0+950000).toISOString()}];
  const observed={kind:'control-observed',mode,window:current.window,workId,caseId,sessionId:session.id,fence,observedAtUtc:new Date(now-200).toISOString(),modelCallsAdded:0,canonicalProcessed:false,probes,stopped:{status:'stopped_before_native',modelPrompts:0,journalAbsent:true,modelChargedAttemptsBefore:35,modelChargedAttemptsAfter:35}};
  const op=await s.pin(mode+'-observed.json',observed);controlPins[mode]={scope,observed:op};controls[mode]={...observed,hostId:'openclaw',classification:'control_observed_awaiting_final_inventory',actions,evidence:{file:op.path,sha256:op.sha256}};}
 controls.classification='controls_observed_awaiting_final_inventory';
 const state:any={window:current.window,planSha256:hash(JSON.stringify(canonical({...program,windowId:current.window}))),started:{openclaw:{workId,caseId,beforeSha256:h('before')}},results:{},effects:{},controlProofs:{openclaw:controls},taskReceipts:s.state.taskReceipts,carriedProgress:s.state.carriedProgress,carriedTaskReceipts:{shared:{acceptedSendRepeated:false,receiptDigest:hash(JSON.stringify(canonical(s.state.taskReceipts.shared)))}}};
 const statePin=await s.pin('actual-controlled-state.json',state),execution=await s.pin('actual-controlled-execution.json',current),initialExecution=await s.pin('initial-control-execution.json',first),frozen=await s.pin('control-ledger.jsonl',await fs.readFile(s.filename,'utf8'));
 const checkpoint:any={purpose:'actual-post-control-stop-evidence-no-recovery',checkedAtUtc:new Date(now).toISOString(),models:35,pending:0,unresolved:0,sharedNativeJournalAbsent:true,meterListening:false,nativeGatewayListening:false,nativeProxyListening:false,gatewayProxyDifferent:true,controlProofs:state.controlProofs,selected:['je1','je2','testowner'].map(role=>({role,stopped:true})),originalJournals:journals.map(j=>({...j,unchanged:true}))};
 const checkpointPin=await s.pin('controlled-checkpoint.json',checkpoint),lost=await s.pin('poll-lost.json',{kind:'actual_sdk_poll_response_lost',window:current.window,role:'openclaw',workId,responseSha256:h('actual inert response')});
 const poll={kind:'actual_sdk_poll_gap_recovered',window:current.window,role:'openclaw',workId,caseId,modelCallsAdded:0,lost:{responseSha256:h('actual inert response'),path:'/events',query:'cursor=1',eventIds:['event_inert']},recovered:{path:'/events',query:'cursor=1',eventIds:['event_inert']}};
 const pollGap=await s.pin('poll-recovered.json',poll),settlement=await s.pin('retryable-settlement.json',{kind:'canonical_settlement',workId,status:'retryable',operation:'fail'});
 const carry:any={purpose:'phase-c-post-control-no-native-checkpoint-review-only',executionAllowed:false,newAuthorityGranted:false,execution,programState:statePin,modelLedger:frozen,originalPacket:packetPin,actualStopObservation:checkpointPin,shared:{workId,caseId},controls:controlPins,events:{actual_sdk_poll_response_lost:lost,actual_sdk_poll_gap_recovered:pollGap,canonical_settlement:settlement}};
 const inventory=JSON.parse(await fs.readFile(r.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();r.currentInventory=await s.pin('controlled-fresh-inventory.json',inventory);
 const preflight={...s.options.preflight,checkedAtMs:now};
 const recovery:any={history:r,runtimePacket:packetPin,initialExecution,execution,operatorSeal:seal,state:statePin,stop,ledger:frozen,checkpoint:checkpointPin,carry:await s.pin('control-carry.json',carry),pollGap,
  canonicalWork:await s.pin('fresh-canonical-retry.json',{database:'sinaloa_staging',readOnly:'on',checkedAt:new Date(now).toISOString(),activeWorkLeases:0,work:{workId,caseId,agentId,status:'retryable',attempts:2,sessions:[{status:'ended'}]}})};
 const target=await s.pin('fixed-runtime-packet.json',{purpose:'phase-c-prepared-controlled-progress-session',clientSource:'1'.repeat(40),serverSource:packet.serverSource,library:{sha256:h('fixed library')},oldKitRoot:s.root,directory:path.join(s.root,'fixed-runtime-session'),states,actors,program:{...program,clientSource:'1'.repeat(40)},controlledRecoveryBase:{...recovery},carriedStateSha256:statePin.sha256,reviewedGraph:s.nextGraph});
 const adoption:any={purpose:'phase-c-explicit-controlled-progress-recovery',version:1,owner:'pjsk02',ownerApproved:true,priorWindow:current.window,priorExecutionSha256:execution.sha256,priorStateSha256:statePin.sha256,priorLedgerSha256:frozen.sha256,checkpointSha256:checkpointPin.sha256,carrySha256:recovery.carry.sha256,clientSource:'1'.repeat(40),serverSource:packet.serverSource,runnerSha256:h('fixed library'),packetSha256:target.sha256,modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:35,currentOperations:32,currentCanonicalMessages:12,currentCases:4,currentAssets:0,repeatOnboarding:false,replayAcceptedSends:false,repeatObservedControls:false,decisionId:'inert-controlled-recovery',receivedAtUtc:new Date(now-1).toISOString(),timeMode:'new-interval',maximumIntervalMs:5400000};
 recovery.adoption=await s.pin('controlled-adoption.json',adoption);recovery.targetPacket=target;
 const receipt={...current.receipt,clientSource:adoption.clientSource,ciHead:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:target.sha256,approvalReceiptSha256:recovery.adoption.sha256,startUtc:new Date(now).toISOString(),hardStopUtc:new Date(now+5400000).toISOString()},signed=s.sign(s.nextGraph,receipt,'fixed runtime');
 return{...s,ledger,workId,caseId,state,checkpoint,carry,poll,adoption,current,options:{...s.options,sameRoleNativeAttribution:async(value:any)=>value,preflight,recovery,receipt,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw,expected:{...s.options.expected,clientSource:receipt.clientSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256}}};
}
it('carries actual prior controls once with no replay, preserving the partial state and binding the same retryable work',async()=>{
 const s=await controlledSetup(),before=await fs.readFile(s.filename),state=await fs.readFile(s.options.recovery.state.path);
 const history=await inspectControlledProgressHistory({releaseRoot:s.root,ledger:s.ledger,recovery:s.options.recovery});expect(history.carriedControlSource).toBe(s.current.receipt.clientSource);
 const handle=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startControlledProgress(handle);expect(c.ledger.snapshot().chargedAttempts).toBe(35);expect((await fs.readFile(s.filename)).subarray(0,before.length)).toEqual(before);expect(await fs.readFile(s.options.recovery.state.path)).toEqual(state);
 for(const id of s.used)expect(()=>c.releaseGroup([id])).toThrow();c.releaseGroup(['openclaw']);
 expect(()=>c.expectWork('openclaw','msg_replacement',h('replacement'))).toThrow();c.stop();
 await expect(ContinuationController.startControlledProgress(handle)).rejects.toThrow('PREPARED_CONTROLLED_PROGRESS_REQUIRED');
});
it.each(['state-changed','missing-control','native-result','native-journal','selected-alive','changed-journal','cap-reset','implicit-clock','future-decision','not-retryable','active-session','wrong-work','foreign-owner','fake-expiry','poll-unrelated','new-native-binding'] as const)('refuses controlled recovery without effects: %s',async fault=>{
 const s=await controlledSetup(),o=s.options,r=o.recovery;
 if(fault==='state-changed')await fs.appendFile(r.state.path,' ');
 if(fault==='missing-control'){delete s.state.controlProofs.openclaw.expiry;r.state=await s.pin('missing-control.json',s.state);}
 if(fault==='native-result'){s.state.results.openclaw={completed:true};r.state=await s.pin('native-result.json',s.state);}
 if(fault==='native-journal')await fs.writeFile(path.join(s.root,'openclaw','scoped-runs',s.workId+'.json'),'{}');
 if(fault==='selected-alive'){s.checkpoint.selected[0].stopped=false;r.checkpoint=await s.pin('alive-checkpoint.json',s.checkpoint);}
 if(fault==='changed-journal')await fs.appendFile(path.join(s.root,'je1','scoped-runs','original-0.json'),' ');
 if(fault==='cap-reset'){s.adoption.currentModels=30;r.adoption=await s.pin('reset-adoption.json',s.adoption);o.receipt.approvalReceiptSha256=r.adoption.sha256;}
 if(fault==='implicit-clock'){s.adoption.timeMode='same-fixed';r.adoption=await s.pin('clock-adoption.json',s.adoption);o.receipt.approvalReceiptSha256=r.adoption.sha256;}
 if(fault==='future-decision'){s.adoption.receivedAtUtc=new Date(Date.now()+1).toISOString();r.adoption=await s.pin('future-adoption.json',s.adoption);o.receipt.approvalReceiptSha256=r.adoption.sha256;}
 if(['not-retryable','active-session','wrong-work'].includes(fault)){const v=JSON.parse(await fs.readFile(r.canonicalWork.path,'utf8'));if(fault==='not-retryable')v.work.status='failed';if(fault==='active-session')v.work.sessions[0].status='active';if(fault==='wrong-work')v.work.workId='msg_other';r.canonicalWork=await s.pin('bad-canonical.json',v);}
 if(fault==='foreign-owner'){const v=s.state.controlProofs.openclaw.pause.actions[0];v.receipt.agentId='agent_foreign';r.state=await s.pin('bad-owner-state.json',s.state);}
 if(fault==='fake-expiry'){const v=JSON.parse(await fs.readFile(s.carry.controls.expiry.scope.path,'utf8'));v.session.expiresAt=v.session.createdAt;s.carry.controls.expiry.scope=await s.pin('bad-expiry-scope.json',v);r.carry=await s.pin('bad-expiry-carry.json',s.carry);}
 if(fault==='poll-unrelated'){s.poll.workId='msg_other';r.pollGap=await s.pin('bad-poll.json',s.poll);}
 if(fault==='new-native-binding'){await s.ledger.bindWork('openclaw',{canonicalWorkHash:h(s.workId),nativeToken:h('native added'),evidenceHash:h('native evidence')});r.ledger=await s.pin('changed-native-ledger.jsonl',await fs.readFile(s.filename,'utf8'));}
 const before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(o)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});
it('retains the original fixed deadline when only source adoption is newly approved',async()=>{
 const s=await controlledSetup(),o=s.options,r=o.recovery;s.adoption.timeMode='same-fixed';r.adoption=await s.pin('same-fixed-adoption.json',s.adoption);
 o.receipt={...o.receipt,approvalReceiptSha256:r.adoption.sha256,startUtc:s.current.receipt.startUtc,hardStopUtc:s.current.receipt.hardStopUtc};const signed=s.sign(s.nextGraph,o.receipt,'same fixed controlled');o.reviewedPlan=signed.plan;o.graphApprovalRaw=signed.raw;
 const c=await ContinuationController.startControlledProgress(await ContinuationController.prepareControlledProgress(o));expect(c.receipt.hardStopUtc).toBe(s.current.receipt.hardStopUtc);c.stop();
});
it('rechecks pinned controls after preparation and before consuming any recovery authority',async()=>{
 const s=await controlledSetup(),before=await fs.readFile(s.filename),h=await ContinuationController.prepareControlledProgress(s.options);
 await fs.appendFile(s.options.recovery.carry.path,' ');await expect(ContinuationController.startControlledProgress(h)).rejects.toThrow('CONTROLLED_PROGRESS_CHANGED');
 expect(await fs.readFile(s.filename)).toEqual(before);expect((await fs.readdir(s.root)).filter(f=>f.startsWith('phase-c-controlled-progress-'))).toEqual([]);
});

async function controlledStartupSetup(timeMode:'same-fixed'|'new-interval'='same-fixed'){
 const s=await controlledSetup(),old=s.options,r=old.recovery,c=await ContinuationController.startControlledProgress(await ContinuationController.prepareControlledProgress(old));c.stop();
 const now=Date.now()+2000;vi.spyOn(Date,'now').mockReturnValue(now);
 const p=JSON.parse(await fs.readFile(r.targetPacket.path,'utf8')),window=hash(JSON.stringify(old.receipt));
 const execution={purpose:'actual-controlled-checkpoint-recovery',receipt:old.receipt,window,graphApprovalRaw:old.graphApprovalRaw,priorExecution:r.execution,carriedState:r.state,carriedCheckpoint:r.carry,sealSha256:h('sealed startup'),actualStartedAtUtc:old.receipt.startUtc};
 const executionPin=await s.pin('actual-startup-execution.json',execution),stop={state:'controlled_recovery_stopped_preserve_originals',phase:'owned-runtime-startup',observedAtUtc:new Date(now-1000).toISOString(),packetSha256:r.targetPacket.sha256,gateComplete:false},stopPin=await s.pin('actual-startup-stop.json',stop),ledgerPin=await s.pin('actual-startup-ledger.jsonl',await fs.readFile(s.filename,'utf8'));
 const originalPacket=JSON.parse(await fs.readFile(r.runtimePacket.path,'utf8'));
 const checkpoint:any={purpose:'actual-controlled-startup-stop-readonly',checkedAtUtc:new Date(now).toISOString(),packet:r.targetPacket,execution:executionPin,stop:stopPin,ledger:ledgerPin,stopState:stop,executionReceipt:execution,usage:{chargedAttempts:35,pending:0,unresolvedDispatches:0},selectedHermesHosts:['je1','je2','testowner'].map(role=>({role,unreachable:true})),ownedMeterListening:false,ownerGatewayContextAbsent:true,sharedNativeJournalAbsent:true,originalJournals:originalPacket.program.originalJournalHashes.map((j:any)=>({role:j.role,file:j.file,unchanged:true})),modelCallsAdded:0,hostStarts:0};
 const frame:any={packet:r.targetPacket,execution:executionPin,stop:stopPin,checkpoint:await s.pin('actual-startup-checkpoint.json',checkpoint),ledger:ledgerPin,adoption:r.adoption,programDirectory:path.join(p.directory,'native-program')};
 const inventory=JSON.parse(await fs.readFile(r.history.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();
 const canonical=JSON.parse(await fs.readFile(r.canonicalWork.path,'utf8'));canonical.checkedAt=new Date(now).toISOString();
 const recovery:any={...r,history:{...r.history,currentInventory:await s.pin('startup-fresh-inventory.json',inventory)},canonicalWork:await s.pin('startup-fresh-canonical.json',canonical),startupStops:[frame]};
 const newPacket=await s.pin('startup-recovery-packet.json',{...p,clientSource:'2'.repeat(40),library:{sha256:h('startup recovery library')},directory:path.join(s.root,'startup-recovery-session'),program:{...p.program,clientSource:'2'.repeat(40)},controlledRecoveryBase:recovery});
 const adoption:any={...s.adoption,priorWindow:window,priorExecutionSha256:executionPin.sha256,priorLedgerSha256:ledgerPin.sha256,startupStopSha256:stopPin.sha256,startupCheckpointSha256:frame.checkpoint.sha256,startupPacketSha256:frame.packet.sha256,clientSource:'2'.repeat(40),runnerSha256:h('startup recovery library'),packetSha256:newPacket.sha256,decisionId:'inert-startup-recovery-decision',receivedAtUtc:new Date(now-1).toISOString(),timeMode};
 recovery.adoption=await s.pin('startup-recovery-adoption.json',adoption);recovery.targetPacket=newPacket;
 const receipt={...old.receipt,clientSource:adoption.clientSource,ciHead:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:newPacket.sha256,approvalReceiptSha256:recovery.adoption.sha256,...(timeMode==='new-interval'?{startUtc:new Date(now).toISOString(),hardStopUtc:new Date(now+5400000).toISOString()}:{})},signed=s.sign(s.nextGraph,receipt,'startup recovery');
 return{...s,old,frame,checkpoint,execution,adoption,options:{...old,recovery,receipt,preflight:{...old.preflight,checkedAtMs:now},reviewedPlan:signed.plan,graphApprovalRaw:signed.raw,expected:{...old.expected,clientSource:receipt.clientSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256}}};
}
it.each(['same-fixed','new-interval'] as const)('recovers a real pre-native startup stop with %s authority and retained controls',async mode=>{
 const s=await controlledStartupSetup(mode),o=s.options,before=await fs.readFile(s.filename),state=await fs.readFile(o.recovery.state.path),oldExecution=await fs.readFile(s.frame.execution.path);
 const handle=await ContinuationController.prepareControlledProgress(o);expect(handle.priorWindow).toBe(s.execution.window);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startControlledProgress(handle);expect(c.ledger.snapshot().chargedAttempts).toBe(35);expect(c.receipt).toEqual(o.receipt);if(mode==='same-fixed')expect(c.receipt.hardStopUtc).toBe(s.old.receipt.hardStopUtc);
 expect((await fs.readFile(s.filename)).subarray(0,before.length)).toEqual(before);expect(await fs.readFile(o.recovery.state.path)).toEqual(state);expect(await fs.readFile(s.frame.execution.path)).toEqual(oldExecution);
 for(const id of s.used)expect(()=>c.releaseGroup([id])).toThrow();c.releaseGroup(['openclaw']);expect(()=>c.expectWork('openclaw','msg_replacement',h('replacement'))).toThrow();c.stop();
 await expect(ContinuationController.startControlledProgress(handle)).rejects.toThrow('PREPARED_CONTROLLED_PROGRESS_REQUIRED');
});
it.each(['program-file','gateway-context','wrong-stop-phase','missing-admission-marker','missing-time-marker','changed-execution','foreign-checkpoint','unreachable-false','invented-journal-proof','native-binding','ledger-whitespace','unapproved-startup','clock-reset'] as const)('refuses startup recovery without mutation: %s',async fault=>{
 const s=await controlledStartupSetup(),o=s.options,r=o.recovery,f=s.frame;
 if(fault==='program-file'){await fs.mkdir(f.programDirectory,{recursive:true});await fs.writeFile(path.join(f.programDirectory,'state.json'),'{}');}
 if(fault==='gateway-context'){await fs.mkdir(path.dirname(f.programDirectory),{recursive:true});await fs.writeFile(path.join(path.dirname(f.programDirectory),'owner-gateway-context.private.json'),'{}');}
 if(fault==='wrong-stop-phase'){const v=JSON.parse(await fs.readFile(f.stop.path,'utf8'));v.phase='remaining-native-program';f.stop=await s.pin('wrong-startup-phase.json',v);}
 if(fault==='missing-admission-marker')await fs.unlink(path.join(s.root,'phase-c-controlled-progress-'+s.current.window+'.used.json'));
 if(fault==='missing-time-marker'){const d=JSON.parse(await fs.readFile(f.adoption.path,'utf8'));await fs.unlink(path.join(s.root,'phase-c-recovery-time-'+h('pjsk02\0'+d.decisionId)+'.used.json'));}
 if(fault==='changed-execution')await fs.appendFile(f.execution.path,' ');
 if(fault==='foreign-checkpoint'){s.checkpoint.packet={...s.checkpoint.packet,sha256:h('foreign')};f.checkpoint=await s.pin('foreign-startup-checkpoint.json',s.checkpoint);}
 if(fault==='unreachable-false'){s.checkpoint.selectedHermesHosts[0].unreachable=false;f.checkpoint=await s.pin('reachable-startup-checkpoint.json',s.checkpoint);}
 if(fault==='invented-journal-proof'){s.checkpoint.originalJournals[0].unchanged=false;f.checkpoint=await s.pin('bad-startup-journals.json',s.checkpoint);}
 if(fault==='native-binding'){const l=await RequestBudgetLedger.open(s.filename);await l.bindWork('openclaw',{canonicalWorkHash:h(s.workId),nativeToken:h('native added'),evidenceHash:h('native proof')});f.ledger=await s.pin('native-startup-ledger.jsonl',await fs.readFile(s.filename,'utf8'));}
 if(fault==='ledger-whitespace')await fs.appendFile(s.filename,'\n');
 if(fault==='unapproved-startup'){const d=JSON.parse(await fs.readFile(f.adoption.path,'utf8'));d.ownerApproved=false;f.adoption=await s.pin('unapproved-original-startup.json',d);}
 if(fault==='clock-reset')o.receipt.hardStopUtc=new Date(Date.parse(o.receipt.hardStopUtc)+1).toISOString();
 const before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(o)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});

async function controlledPreTargetSetup(){
 const s=await controlledStartupSetup(),r=s.options.recovery,f=s.frame,p=JSON.parse(await fs.readFile(f.packet.path,'utf8')),e=s.execution;
 const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 const save=async(name:string,value:any)=>{const raw=typeof value==='string'?value:JSON.stringify(value),file=path.join(f.programDirectory,name);await fs.writeFile(file,raw);return{path:file,sha256:h(raw)};};
 await fs.mkdir(f.programDirectory,{recursive:true});
 const selected={case:{id:s.caseId},messages:[{id:s.workId,caseId:s.caseId}]},selection=await save('selected.json',selected);
 const descriptor={...r.carry,bytes:(await fs.stat(r.carry.path)).size},oldSource=s.current.receipt.clientSource,oldWindow=s.current.window;
 const state:any={phase:'prepared',window:e.window,planSha256:h(JSON.stringify(canon({...p.program,windowId:e.window}))),started:{openclaw:{workId:s.workId,caseId:s.caseId,beforeSha256:selection.sha256}},results:{},effects:{},controlProofs:s.state.controlProofs,taskReceipts:s.state.taskReceipts,carriedProgress:s.state.carriedProgress,carriedTaskReceipts:s.state.carriedTaskReceipts,
  carriedControlObservations:{openclaw:{priorSource:oldSource,priorWindow:oldWindow,descriptor,controlsRepeated:false,newSourceControlCredit:false}},
  carriedOpenClawPollObservation:{priorSource:oldSource,priorWindow:oldWindow,descriptor,workId:s.workId,pollInterruptedAgain:false,newSourcePollCredit:false}};
 const send={windowId:e.window,startUtc:e.receipt.startUtc,hardStopUtc:e.receipt.hardStopUtc,clientSource:e.receipt.clientSource,librarySha256:e.receipt.runnerSha256};
 const context={window:e.window,hardStopUtc:e.receipt.hardStopUtc,librarySha256:e.receipt.runnerSha256};
 const contextFile=path.join(p.directory,'owner-gateway-context.private.json');await fs.writeFile(contextFile,JSON.stringify(context));
 const atUtc=new Date(Date.parse(s.checkpoint.stopState.observedAtUtc)-1).toISOString(),row=(kind:string,fields:any={})=>({atUtc,window:e.window,kind,...fields});
 const events:any[]=[...['je1','testowner'].map(role=>row('actual_hermes_gateway_ready',{role,modelRequestsAdded:0})),row('actual_session_started_awaiting_personal_gateway_addresses',{modelCalls:35,onboardingRepeated:false,acceptedSendsRepeated:false}),
  ...['je1','testowner','openclaw'].map(role=>row('existing_receiver_ready',{role,receivingStarted:false,newEnrollment:false})),row('owned_native_factory_ready',{nativeGatewayStarted:false,modelPromptsSubmitted:0}),
  row('prior_openclaw_controls_carried_without_repetition',{priorSource:oldSource,priorWindow:oldWindow,workId:s.workId,descriptorSha256:r.carry.sha256,newControlRun:false}),
  row('prior_openclaw_poll_gap_carried_without_repetition',{priorSource:oldSource,priorWindow:oldWindow,workId:s.workId,descriptorSha256:r.carry.sha256,newPollInterruption:false}),
  row('actual_canonical_context',{flowId:'openclaw',role:'openclaw',workId:s.workId,caseId:s.caseId,session:{id:'scope_retry',fence:4,agentId:p.actors.openclaw.agentId,installationId:p.actors.openclaw.installationId}}),
  row('actual_bounded_case_snapshot',{flowId:'openclaw',workId:s.workId,caseId:s.caseId,rawSnapshotBytes:JSON.stringify(selected),sha256:h(JSON.stringify(selected))}),row('canonical_settlement',{role:'openclaw',workId:s.workId,status:'retryable',operation:'fail'})];
 const eventsFile=path.join(p.directory,'actual-events.private.jsonl');
 const refresh=async()=>{
  const statePin=await save('state.json',state),nativeSendContext=await save('native-send-context.private.json',send);
  await fs.writeFile(contextFile,JSON.stringify(context));const ownerGatewayContext={path:contextFile,sha256:h(JSON.stringify(context))};
  const raw=events.map(v=>JSON.stringify(v)+'\n').join('');await fs.writeFile(eventsFile,raw);
  f.preTarget={state:statePin,selection,nativeSendContext,ownerGatewayContext,events:{path:eventsFile,sha256:h(raw)}};
  const stop={...s.checkpoint.stopState,phase:'remaining-native-program'};f.stop=await s.pin('actual-pretarget-stop.json',stop);
  Object.assign(s.checkpoint,{purpose:'actual-controlled-pretarget-stop-readonly',stop:f.stop,stopState:stop,preTargetPins:f.preTarget,ownerGatewayContextAbsent:false,receiversStopped:true,operatorWorkerStopped:true,nativeGatewayListening:false,nativeProxyListening:false});
  f.checkpoint=await s.pin('actual-pretarget-checkpoint.json',s.checkpoint);
  s.adoption.startupStopSha256=f.stop.sha256;s.adoption.startupCheckpointSha256=f.checkpoint.sha256;r.adoption=await s.pin('pretarget-adoption.json',s.adoption);s.options.receipt.approvalReceiptSha256=r.adoption.sha256;
  const signed=s.sign(s.nextGraph,s.options.receipt,'pretarget recovery');s.options.reviewedPlan=signed.plan;s.options.graphApprovalRaw=signed.raw;
 };
 await refresh();return{...s,preTargetState:state,events,context,send,refresh};
}
it('recovers an actual zero-native receiver stop, retaining its partial files and the original fixed deadline',async()=>{
 const s=await controlledPreTargetSetup(),before=await fs.readFile(s.filename),state=await fs.readFile(s.frame.preTarget.state.path),events=await fs.readFile(s.frame.preTarget.events.path);
 const handle=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startControlledProgress(handle);expect(c.receipt.hardStopUtc).toBe(s.old.receipt.hardStopUtc);expect(c.ledger.snapshot().chargedAttempts).toBe(35);
 expect(await fs.readFile(s.frame.preTarget.state.path)).toEqual(state);expect(await fs.readFile(s.frame.preTarget.events.path)).toEqual(events);
 expect((await fs.readFile(s.filename)).subarray(0,before.length)).toEqual(before);c.releaseGroup(['openclaw']);expect(()=>c.expectWork('openclaw','msg_replacement',h('replacement'))).toThrow();c.stop();
});
it.each(['native-result','native-effect','new-control-credit','repeated-poll','wrong-shared-work','wrong-selection','context-clock','send-source','processed-settlement','foreign-session','unknown-model-event','snapshot-drift','missing-receiver','native-evidence','owner-request','extra-program-file','changed-state','cleanup-incomplete'] as const)('refuses pre-target recovery without mutation: %s',async fault=>{
 const s=await controlledPreTargetSetup(),v=s.preTargetState;
 if(fault==='native-result')v.results.openclaw={completed:true};if(fault==='native-effect')v.effects.openclaw={sent:true};
 if(fault==='new-control-credit')v.carriedControlObservations.openclaw.newSourceControlCredit=true;
 if(fault==='repeated-poll')v.carriedOpenClawPollObservation.pollInterruptedAgain=true;
 if(fault==='wrong-shared-work')v.started.openclaw.workId='msg_other';if(fault==='wrong-selection')v.started.openclaw.beforeSha256=h('other snapshot');
 if(fault==='context-clock')s.context.hardStopUtc=new Date(Date.now()+5400001).toISOString();if(fault==='send-source')s.send.clientSource='9'.repeat(40);
 if(fault==='processed-settlement')s.events.at(-1)!.status='processed';if(fault==='foreign-session')s.events.find(e=>e.kind==='actual_canonical_context').session.agentId='agent_other';
 if(fault==='unknown-model-event')s.events.push({...s.events[0],kind:'actual_model_submitted'});if(fault==='snapshot-drift')s.events.find(e=>e.kind==='actual_bounded_case_snapshot').sha256=h('not snapshot');
 if(fault==='missing-receiver')s.events.splice(s.events.findIndex(e=>e.kind==='existing_receiver_ready'),1);
 if(fault==='cleanup-incomplete')s.checkpoint.receiversStopped=false;
 await s.refresh();
 if(['native-evidence','owner-request'].includes(fault)){const dir=path.join(path.dirname(s.frame.programDirectory),fault==='native-evidence'?'openclaw-evidence':'owner-requests');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'unreviewed.json'),'{}');}
 if(fault==='extra-program-file')await fs.writeFile(path.join(s.frame.programDirectory,'extra.json'),'{}');
 if(fault==='changed-state')await fs.appendFile(s.frame.preTarget.state.path,' ');
 if(fault==='cleanup-incomplete'){s.checkpoint.receiversStopped=false;s.frame.checkpoint=await s.pin('bad-pretarget-cleanup.json',s.checkpoint);}
 const before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});

async function unforwardedSetup(){
 const s=await controlledPreTargetSetup(),r=s.options.recovery,f=s.frame,p=JSON.parse(await fs.readFile(f.packet.path,'utf8')),e=s.execution;
 const journal=await s.pin('observer-journal.json',{version:1,model:'openclaw:inert',workId:s.workId,completed:false,providerCalls:1,pending:[],input:[{role:'system',content:'fixture system'},{role:'user',content:'fixture snapshot'}]});
 const journalPath=path.join(p.states.openclaw,'scoped-runs',s.workId+'.json');await fs.copyFile(journal.path,journalPath);journal.path=journalPath;
 const w={workId:s.workId,caseId:s.caseId,agentId:s.options.actorIds.openclaw,status:'failed',attempts:5,failure:{retryable:false,reasonCode:'HANDLER_FAILED'},sessions:[{status:'ended'}]};
 const canonical=await s.pin('observer-failed-canonical.json',{database:'sinaloa_staging',readOnly:'on',checkedAt:new Date(Date.now()).toISOString(),activeWorkLeases:0,activeCaseSessions:0,work:w,message:{id:s.workId,caseId:s.caseId,status:'failed',processedAt:null},sessions:w.sessions});r.canonicalWork=canonical;
 s.events.at(-1)!.status='failed';await s.refresh();
 const privateCauses=[await s.pin('primary.log','ACTUAL_OWNED_NATIVE_CHILD_REQUIRED at observeTransport'),await s.pin('secondary.log','ACTUAL_LOST_RESPONSE_AND_IDENTICAL_REPLAY_REQUIRED')];
 const historicalCanonical=JSON.parse(await fs.readFile(canonical.path,'utf8'));delete historicalCanonical.work.caseId;delete historicalCanonical.work.agentId;const historicalCanonicalPin=await s.pin('historical-user-sql-canonical.json',historicalCanonical);
 const local=await s.pin('observer-local.json',{journal,modelsAdded:0,ports:[{listening:false},{listening:false},{listening:false}]});
 const requestDir=path.join(p.directory,'owner-requests'),evidenceDir=path.join(p.directory,'openclaw-evidence');await fs.mkdir(requestDir);await fs.mkdir(evidenceDir);
 const move=async(pin:any,dir:string,name:string)=>{const to=path.join(dir,name);await fs.copyFile(pin.path,to);return{path:to,sha256:pin.sha256};};
 const targetStop=new Date(Date.parse(e.receipt.startUtc)+500).toISOString(),decision=JSON.stringify({ownerApproved:true,window:e.window,clientSource:e.receipt.clientSource,approvedAtUtc:e.receipt.startUtc,expiresAtUtc:targetStop});
 const response=await move(await s.pin('personal-response.json',{window:e.window,results:[{workId:s.workId,targetDecisionRaw:decision,capabilityDecisionRaw:decision}]}),requestDir,'review.response.json');
 const request=await move(await s.pin('personal-request.json',{window:e.window,hardStopUtc:targetStop,targets:[{workId:s.workId,hardStopUtc:targetStop}],receiptPath:response.path}),requestDir,'review.request.json');
 const nativeEvidence=[];for(const name of ['actual-owner-decisions-fixture.json','personal-review-subjects-fixture.json'])nativeEvidence.push(await move(await s.pin(name,{}),evidenceDir,name));
 const originals=[];for(const j of p.program.originalJournalHashes)originals.push({path:path.join(p.states[j.role],'scoped-runs',j.file),sha256:j.sha256});
 const modelFiles=[];for(let i=0;i<6;i++)modelFiles.push(await s.pin('model-config-'+i,'inert config'));
 const frozen:any={purpose:'actual-observer-order-zero-forwarding-stop-readonly',checkedAtUtc:new Date(Date.now()).toISOString(),packet:f.packet,execution:f.execution,stop:f.stop,adoption:f.adoption,ledger:f.ledger,programState:f.preTarget.state,events:f.preTarget.events,ownerGatewayContext:f.preTarget.ownerGatewayContext,
  usage:s.checkpoint.usage,journal,canonical:historicalCanonicalPin,local,privateCauses,ownerRequests:[{request,response,hardStopUtc:targetStop}],nativeEvidence,originalJournals:originals,modelFiles,actionLedger:r.history.actionLedger,seal:await s.pin('observer-seal.json',{}),
  primaryCode:'ACTUAL_OWNED_NATIVE_CHILD_REQUIRED',outerCode:'SCOPED_PROVIDER_UNAVAILABLE',secondaryCode:'ACTUAL_LOST_RESPONSE_AND_IDENTICAL_REPLAY_REQUIRED',logicalProviderIterations:1,physicalRequestsAdded:0,modelsAdded:0,
  nativeBootstrapAdmitted:false,nativeHarnessObserved:false,nativePhysicalObserved:false,nativeResponseObserved:false,canonicalProcessed:false,taskReplayPerformed:false,oldAcceptedSendsRepeated:false,completedControlsRepeated:false,wholeGateComplete:false};
 const followup:any={version:1,requestId:'65608c60-b9d6-4323-8ccc-1209bc04ad28',retainedFailedWorkId:s.workId,retainedFailedJournalSha256:journal.sha256,caseId:s.caseId,senderRole:'testowner',recipientRole:'openclaw',senderAgentId:s.options.actorIds.testowner,recipientAgentId:s.options.actorIds.openclaw,text:'A distinct new follow-up after the failed work.',additionalOperationReservations:1,newCasesAdded:0,newInstallationsAdded:0,newAssetsAdded:0,requiresActualHumanSendConfirmation:true,acceptedSendRepeated:false,failedWorkRequeued:false};
 const refresh=async()=>{f.preTarget.unforwarded=await s.pin('unforwarded-proof.json',frozen);s.checkpoint.preTargetPins=f.preTarget;s.checkpoint.sharedNativeJournalAbsent=false;f.checkpoint=await s.pin('unforwarded-checkpoint.json',s.checkpoint);
  r.distinctFollowup=await s.pin('distinct-followup.json',followup);s.adoption.startupCheckpointSha256=f.checkpoint.sha256;s.adoption.distinctFollowupSha256=r.distinctFollowup.sha256;s.adoption.preserveFailedOriginal=true;
  r.adoption=await s.pin('unforwarded-adoption.json',s.adoption);s.options.receipt.approvalReceiptSha256=r.adoption.sha256;const signed=s.sign(s.nextGraph,s.options.receipt,'unforwarded');s.options.reviewedPlan=signed.plan;s.options.graphApprovalRaw=signed.raw;};
 await refresh();return{...s,frozen,followup,journal,refreshUnforwarded:refresh};
}
it('preserves the unforwarded failed original and only admits the explicitly reviewed distinct follow-up',async()=>{
 const s=await withOperationAmendment(),before=await fs.readFile(s.filename),journal=await fs.readFile(s.journal.path);
 const handle=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startControlledProgress(handle);c.releaseGroup(['openclaw']);
 expect(()=>c.expectWork('openclaw',s.workId,h('old'))).toThrow('PRIOR_NATIVE_WORK_MUST_NOT_REPEAT');
 c.expectWork('openclaw','msg_distinct',h('canonical new receipt'));
 const message={id:'msg_distinct',caseId:s.caseId,text:s.followup.text,senderAgentId:s.followup.senderAgentId,recipientAgentId:s.followup.recipientAgentId};
 expect(()=>c.observeClaim('openclaw','openclaw',{workId:'msg_distinct',message:{...message,text:'foreign'}},'{}')).toThrow('EXACT_DISTINCT_FOLLOWUP_MESSAGE_REQUIRED');
 c.observeClaim('openclaw','openclaw',{workId:'msg_distinct',message},'{}');expect(await fs.readFile(s.journal.path)).toEqual(journal);c.stop();
});
it.each(['physical-dispatch','logical-iterations','completed-journal','pending-tool','wrong-primary','live-port','processed-original','retryable-original','different-case','same-old-text','missing-review','missing-followup-approval'] as const)('refuses an unforwarded recovery without mutation: %s',async fault=>{
 const s=await withOperationAmendment(),r=s.options.recovery;
 if(fault==='physical-dispatch')s.frozen.physicalRequestsAdded=1;if(fault==='logical-iterations')s.frozen.logicalProviderIterations=2;
 if(fault==='completed-journal'||fault==='pending-tool'){const j=JSON.parse(await fs.readFile(s.journal.path,'utf8'));if(fault==='completed-journal')j.completed=true;else j.pending=[{}];await fs.writeFile(s.journal.path,JSON.stringify(j));}
 if(fault==='wrong-primary')s.frozen.primaryCode='OTHER';
 if(fault==='live-port'){const local=JSON.parse(await fs.readFile(s.frozen.local.path,'utf8'));local.ports[0].listening=true;s.frozen.local=await s.pin('live-port.json',local);}
 if(fault==='processed-original'||fault==='retryable-original'){const v=JSON.parse(await fs.readFile(r.canonicalWork.path,'utf8'));v.work.status=fault==='processed-original'?'processed':'retryable';r.canonicalWork=await s.pin('wrong-original.json',v);}
 if(fault==='different-case')s.followup.caseId='case_foreign';if(fault==='same-old-text'){s.followup.text='';}
 await s.refreshUnforwarded();if(fault==='missing-review')delete r.distinctFollowup;
 if(fault==='missing-followup-approval'){delete s.adoption.distinctFollowupSha256;r.adoption=await s.pin('missing-followup-approval.json',s.adoption);s.options.receipt.approvalReceiptSha256=r.adoption.sha256;const signed=s.sign(s.nextGraph,s.options.receipt,'unapproved');s.options.reviewedPlan=signed.plan;s.options.graphApprovalRaw=signed.raw;}
 const before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});

async function withOperationAmendment(){
 const s=await unforwardedSetup(),r=s.options.recovery;
 const allocations=[1,2,4,2,2,4,1,2,2,1].map((minimumReservations,i)=>({item:'required operation group '+i,minimumReservations}));
 r.operationAmendment={operationCap:62,normalCeiling:54,cleanupReserve:8,allocation:await s.pin('operation-allocation.json',{currentConservativeReservations:s.options.preflight.conservativeMessages,newFollowupIncluded:true,allocations,minimumAdditionalReservations:21,minimumNormalTotal:s.options.preflight.conservativeMessages+21,normalCeiling:54,cleanupReserve:8,overallCeiling:62})};
 Object.assign(s.adoption,{operationCap:62,normalOperationCap:54,cleanupReserve:8,operationAllocationSha256:r.operationAmendment.allocation.sha256});
 const refresh=async()=>{r.adoption=await s.pin('amended-resource-adoption.json',s.adoption);s.options.receipt.approvalReceiptSha256=r.adoption.sha256;const signed=s.sign(s.nextGraph,s.options.receipt,'operation amended');s.options.reviewedPlan=signed.plan;s.options.graphApprovalRaw=signed.raw;};
 await refresh();return{...s,refreshAmendment:refresh};
}
it('accepts only explicitly approved 62 total / 54 normal / 8 cleanup bounds and retains all prior reservations',async()=>{
 const s=await withOperationAmendment(),c=await ContinuationController.startControlledProgress(await ContinuationController.prepareControlledProgress(s.options));
 expect(c.operationBounds).toEqual({operationCap:62,normalCeiling:54,cleanupReserve:8});expect(Object.isFrozen(c.operationBounds)).toBe(true);expect(c.ledger.snapshot().chargedAttempts).toBe(35);c.stop();
});
it.each(['unapproved-cap','reduced-cleanup','unbounded-cap','allocation-changed','missing-allocation-approval'] as const)('refuses operation amendment %s',async fault=>{
 const s=await withOperationAmendment(),r=s.options.recovery;
 if(fault==='unapproved-cap')s.adoption.operationCap=60;
 if(fault==='reduced-cleanup')r.operationAmendment.cleanupReserve=6;
 if(fault==='unbounded-cap')r.operationAmendment.operationCap=100;
 if(fault==='allocation-changed')await fs.appendFile(r.operationAmendment.allocation.path,' ');
 if(fault==='missing-allocation-approval')delete s.adoption.operationAllocationSha256;
 await s.refreshAmendment();const before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);
});

it('refuses the complete distinct follow-up plan without the explicit operation amendment',async()=>{
 const s=await unforwardedSetup(),before=await fs.readFile(s.filename);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow('EXACT_OPERATION_AMENDMENT_REQUIRED');expect(await fs.readFile(s.filename)).toEqual(before);
});

async function acceptedCheckpointSetup(){
 const s=await withOperationAmendment(),o=s.options,r=o.recovery,canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 if(o.preflight.conservativeMessages===32){
  const file=path.join(s.root,'phase-c-cumulative-actions.jsonl'),raw=await fs.readFile(file,'utf8'),last=raw.trimEnd().split('\n').at(-1)!;
  const next=raw+JSON.stringify({previous:h(last+'\n'),kind:'operation',operationKind:'message',caseId:s.caseId})+'\n';await fs.writeFile(file,next);r.history.actionLedger=await s.pin('accepted-before-actions.jsonl',next);
  o.preflight.conservativeMessages=33;s.adoption.currentOperations=33;const allocation=JSON.parse(await fs.readFile(r.operationAmendment.allocation.path,'utf8'));allocation.currentConservativeReservations=33;allocation.minimumNormalTotal=54;
  r.operationAmendment.allocation=await s.pin('accepted-before-allocation.json',allocation);s.adoption.operationAllocationSha256=r.operationAmendment.allocation.sha256;
 }
 const now=Date.now()+2000;vi.spyOn(Date,'now').mockReturnValue(now);
 const p=JSON.parse(await fs.readFile(r.targetPacket.path,'utf8')),seal=await s.pin('accepted-seal.json',{purpose:'inert sealed code'});
 p.sealPath=seal.path;p.controlledRecoveryBase=structuredClone(r);p.decisionPaths={adoption:path.join(p.directory,'decisions','adoption.actual-human.private.json')};
 const packet=await s.pin('accepted-start-packet.json',p);r.targetPacket=packet;
 Object.assign(s.adoption,{packetSha256:packet.sha256,decisionId:'accepted-checkpoint-original-window',receivedAtUtc:new Date(now-1).toISOString(),timeMode:'new-interval'});
 await fs.mkdir(path.join(p.directory,'decisions'),{recursive:true});const adoptionFile=p.decisionPaths.adoption,adoptionRaw=JSON.stringify(s.adoption);await fs.writeFile(adoptionFile,adoptionRaw);r.adoption={path:adoptionFile,sha256:h(adoptionRaw)};
 await fs.writeFile(path.join(p.directory,'ADOPTION-RECORDED.private.json'),JSON.stringify({purpose:'actual-startup-source-time-decision-record-no-clock',clockStarted:false,sealSha256:seal.sha256,packetSha256:packet.sha256,adoption:r.adoption}));
 o.receipt={...o.receipt,packetSha256:packet.sha256,approvalReceiptSha256:r.adoption.sha256,startUtc:new Date(now).toISOString(),hardStopUtc:new Date(now+5400000).toISOString()};
 o.expected={...o.expected,packetSha256:packet.sha256};
 const signed=s.sign(s.nextGraph,o.receipt,'accepted original');o.reviewedPlan=signed.plan;o.graphApprovalRaw=signed.raw;o.preflight.checkedAtMs=now;
 const inventory=JSON.parse(await fs.readFile(r.history.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();r.history.currentInventory=await s.pin('accepted-before-inventory.json',inventory);
 const oldCanonical=JSON.parse(await fs.readFile(r.canonicalWork.path,'utf8'));oldCanonical.checkedAt=new Date(now).toISOString();r.canonicalWork=await s.pin('accepted-before-canonical.json',oldCanonical);
 const handle=await ContinuationController.prepareControlledProgress(o),oldLedger=await fs.readFile(s.filename),controller=await ContinuationController.startControlledProgress(handle);controller.stop();
 const currentWindow=h(JSON.stringify(o.receipt)),execution={purpose:'actual-controlled-checkpoint-recovery',receipt:o.receipt,window:currentWindow,graphApprovalRaw:o.graphApprovalRaw,
  priorExecution:r.startupStops.at(-1).execution,carriedState:r.state,carriedCheckpoint:r.carry,sealSha256:seal.sha256,actualStartedAtUtc:o.receipt.startUtc};
 const executionPin=await s.pin('accepted-execution.json',execution);vi.spyOn(Date,'now').mockReturnValue(now+2000);
 let actions=await fs.readFile(path.join(s.root,'phase-c-cumulative-actions.jsonl'),'utf8');const last=actions.trimEnd().split('\n').at(-1)!;
 actions+=JSON.stringify({previous:h(last+'\n'),kind:'operation',operationKind:'message',caseId:s.caseId})+'\n';await fs.writeFile(path.join(s.root,'phase-c-cumulative-actions.jsonl'),actions);
 const workId='msg_accepted_checkpoint',programDir=path.join(p.directory,'native-program');await fs.mkdir(programDir,{recursive:true});
 const personal={purpose:'phase-c-personal-followup-confirmation',version:1,windowId:currentWindow,name:'openclaw-ready-checkpoint',requestId:s.followup.requestId,subjectSha256:h('personal subject'),humanConfirmed:true,confirmedAtUtc:new Date(now+100).toISOString()};
 const personalPin=await s.pin('accepted-personal.json',personal),ownerDigest=h(JSON.stringify(canon(personal)));
 const selected={case:{id:s.caseId},messages:[{id:workId,caseId:s.caseId,text:s.followup.text,senderAgentId:s.followup.senderAgentId,recipientAgentId:s.followup.recipientAgentId}]};
 const selectedRaw=JSON.stringify(selected);await fs.writeFile(path.join(programDir,'selected-checkpoint.json'),selectedRaw);
 const accepted={state:'accepted',requestId:s.followup.requestId,caseId:s.caseId,messageId:workId,senderRole:'testowner',recipientAddress:'inert@example.invalid',ownerReceiptSha256:ownerDigest,canonicalSha256:h(selectedRaw),failedOriginalPreserved:true,originalAcceptedSendRepeated:false};
 const original=JSON.parse(await fs.readFile(r.state.path,'utf8'));
 const state={...original,phase:'prepared',window:currentWindow,planSha256:h(JSON.stringify(canon({...p.program,windowId:currentWindow}))),started:{openclaw:{workId,caseId:s.caseId,beforeSha256:h(selectedRaw)}},
  observerFollowupAttempt:{requestId:s.followup.requestId,subjectSha256:personal.subjectSha256,ownerReceiptSha256:ownerDigest,state:'accepted'},
  retainedObserverFailedOriginal:{workId:s.workId,caseId:s.caseId,canonicalStatus:'failed',attempts:5,neverReplay:true,journalSha256:s.journal.sha256,journal:s.journal},distinctFollowupReceipts:{openclaw:accepted},
  carriedControlObservations:s.preTargetState.carriedControlObservations,carriedOpenClawPollObservation:s.preTargetState.carriedOpenClawPollObservation};
 const stateRaw=JSON.stringify(state),stateFile=path.join(programDir,'accepted-state.json');await fs.writeFile(stateFile,stateRaw);const programState={path:stateFile,sha256:h(stateRaw)};
 const stop=await s.pin('accepted-native-stop.json',{state:'controlled_recovery_stopped_preserve_originals',phase:'remaining-native-program',observedAtUtc:new Date(now+1000).toISOString(),packetSha256:packet.sha256,gateComplete:false});
 const newWork={workId,status:'retryable',attempts:1,failure:{retryable:true,reasonCode:'HANDLER_FAILED'},messageStatus:'acknowledged',processedAt:null},oldWork={workId:s.workId,status:'failed',attempts:5,failure:{retryable:false,reasonCode:'HANDLER_FAILED'}};
 const canonicalStop={database:'sinaloa_staging',readOnly:'on',checkedAt:new Date(now+1500).toISOString(),activeWorkLeases:0,activeCaseSessions:0,work:[newWork,oldWork],sessions:[{workId,status:'ended'},{workId:s.workId,status:'ended'}]};
 const journal={version:1,workId,model:'openclaw:http://127.0.0.1:19000:main',providerCalls:1,completed:false,pending:[],input:[{role:'system',content:'inert instructions'},{role:'user',content:'inert snapshot'}]};
 const journalPath=path.join(p.states.openclaw,'scoped-runs',workId+'.json');await fs.writeFile(journalPath,JSON.stringify(journal));const journalPin={path:journalPath,sha256:h(JSON.stringify(journal))};
 const d:any={purpose:'actual-accepted-checkpoint-native-start-stop-inspection',version:1,executionAllowed:false,newAuthorityGranted:false,checkedAtUtc:new Date(now+2000).toISOString(),window:currentWindow,fixedHardStopUtc:o.receipt.hardStopUtc,source:o.receipt.clientSource,
  packet,seal,execution:executionPin,stop,programState,frozenRequests:await s.pin('accepted-request-snapshot.jsonl',await fs.readFile(s.filename,'utf8')),frozenActions:await s.pin('accepted-action-snapshot.jsonl',actions),personalSend:personalPin,
  canonicalStop:await s.pin('accepted-canonical-stop.json',canonicalStop),cleanup:await s.pin('accepted-cleanup.json',{checkedAtUtc:new Date(now+1500).toISOString(),ports:[{listening:false},{listening:false},{listening:false}],hermes:['je1','testowner'].map(role=>({role,running:false})),modelsAdded:0,tasksSent:0}),
  accounting:await s.pin('accepted-accounting.json',{window:currentWindow,operations:34,assets:0,counts:{chargedAttempts:35,pending:0,unresolvedDispatches:0,knownOpenClawDispatches:0},retainedConfigUnchanged:true,oldFailedJournalUnchanged:true,replayAttempted:false,newLiveAdmission:false,newWindow:false}),
  checkpointJournal:journalPin,acceptedReceipt:accepted,models:35,operations:34,assets:0,sameAcceptedSendMustNotRepeat:true,failedOriginalMustRemainFailed:true,oldAdmissionMustNotReplay:true};
 r.acceptedCheckpoint=await s.pin('accepted-checkpoint-descriptor.json',d);
 const priorAllocation=r.operationAmendment.allocation,allocation=JSON.parse(await fs.readFile(priorAllocation.path,'utf8'));
 r.operationAmendment={...r.operationAmendment,allocation:await s.pin('accepted-remaining-allocation.json',{currentConservativeReservations:34,acceptedFollowupCarried:true,newFollowupIncluded:false,previousAllocationSha256:priorAllocation.sha256,allocations:allocation.allocations.slice(1),minimumAdditionalReservations:20,minimumNormalTotal:54,normalCeiling:54,cleanupReserve:8,overallCeiling:62})};
 r.history.actionLedger=d.frozenActions;inventory.checkedAt=new Date(now+2000).toISOString();inventory.canonicalMessageEffects++;r.history.currentInventory=await s.pin('accepted-fresh-inventory.json',inventory);
 r.canonicalWork=await s.pin('accepted-fresh-canonical.json',{database:'sinaloa_staging',readOnly:'on',checkedAt:inventory.checkedAt,activeWorkLeases:0,activeCaseSessions:0,work:{...newWork,caseId:s.caseId,agentId:o.actorIds.openclaw,sessions:[{status:'ended'}]},retainedOriginal:{...oldWork,caseId:s.caseId,agentId:o.actorIds.openclaw}});
 const target=await s.pin('accepted-retry-packet.json',{...p,clientSource:'4'.repeat(40),library:{sha256:h('accepted retry library')},carriedStateSha256:r.state.sha256});r.targetPacket=target;
 const adoption:any={...s.adoption,priorWindow:currentWindow,priorExecutionSha256:executionPin.sha256,priorLedgerSha256:d.frozenRequests.sha256,clientSource:'4'.repeat(40),runnerSha256:h('accepted retry library'),packetSha256:target.sha256,
  decisionId:'accepted-retry-new-source-same-clock',receivedAtUtc:new Date(now+1900).toISOString(),timeMode:'same-fixed',currentOperations:34,currentCanonicalMessages:inventory.canonicalMessageEffects,acceptedCheckpointSha256:r.acceptedCheckpoint.sha256,operationAllocationSha256:r.operationAmendment.allocation.sha256};delete adoption.distinctFollowupSha256;
 const originalReceipt=o.receipt;o.receipt={...o.receipt,clientSource:adoption.clientSource,ciHead:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:target.sha256};
 const refresh=async()=>{r.acceptedCheckpoint=await s.pin('accepted-checkpoint-descriptor.json',d);adoption.acceptedCheckpointSha256=r.acceptedCheckpoint.sha256;r.adoption=await s.pin('accepted-retry-adoption.json',adoption);o.receipt.approvalReceiptSha256=r.adoption.sha256;
  const signed=s.sign(s.nextGraph,o.receipt,'accepted retry');o.reviewedPlan=signed.plan;o.graphApprovalRaw=signed.raw;};
 o.expected={...o.expected,clientSource:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:target.sha256};o.preflight={...o.preflight,checkedAtMs:now+2000,conservativeMessages:34,canonicalEffects:inventory.canonicalMessageEffects};
 await refresh();return{...s,descriptor:d,acceptedState:state,canonicalStop,newWork,oldWork,workId,originalReceipt,oldLedger,adoption,refreshAccepted:refresh,journalPin};
}
it('retries only the accepted checkpoint through a fresh canonical claim with no resend, journal reset or clock extension',async()=>{
 const s=await acceptedCheckpointSetup(),before=await fs.readFile(s.filename),journal=await fs.readFile(s.journalPin.path),failed=await fs.readFile(s.journal.path);
 const handle=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(before);
 const c=await ContinuationController.startControlledProgress(handle);expect(c.receipt.hardStopUtc).toBe(s.originalReceipt.hardStopUtc);expect(c.operationBounds).toEqual({operationCap:62,normalCeiling:54,cleanupReserve:8});
 c.releaseGroup(['openclaw']);expect(()=>c.expectWork('openclaw',s.descriptor.acceptedReceipt.messageId+'wrong',h('wrong'))).toThrow('CANONICAL_WORK_BINDING_CHANGED');expect(()=>c.expectWork('openclaw',s.followup.retainedFailedWorkId,h('old'))).toThrow('PRIOR_NATIVE_WORK_MUST_NOT_REPEAT');
 c.expectWork('openclaw',s.workId,h('fresh canonical'));const message={id:s.workId,caseId:s.caseId,text:s.followup.text,senderAgentId:s.followup.senderAgentId,recipientAgentId:s.followup.recipientAgentId};
 expect(()=>c.observeClaim('openclaw','openclaw',{workId:s.workId,message:{...message,text:'replacement'}},'{}')).toThrow('EXACT_DISTINCT_FOLLOWUP_MESSAGE_REQUIRED');
 c.observeClaim('openclaw','openclaw',{workId:s.workId,message},'{}');expect(await fs.readFile(s.journalPin.path)).toEqual(journal);expect(await fs.readFile(s.journal.path)).toEqual(failed);expect(c.ledger.snapshot().chargedAttempts).toBe(35);c.stop();
});
it.each(['descriptor-drift','processed','nonretryable','active-session','repeated-send','reset-journal','journal-pending','wrong-owner','operation-refund','model-uncertain','live-port','changed-old-journal','missing-allocation','clock-extension'] as const)('refuses accepted checkpoint retry before mutation: %s',async fault=>{
 const s=await acceptedCheckpointSetup(),d=s.descriptor,o=s.options,r=o.recovery;
 if(fault==='processed'||fault==='nonretryable'||fault==='active-session'){if(fault==='processed')s.canonicalStop.work[0].processedAt=new Date(Date.now()).toISOString();if(fault==='nonretryable')s.canonicalStop.work[0].failure.retryable=false;if(fault==='active-session')s.canonicalStop.sessions[0].status='active';d.canonicalStop=await s.pin('accepted-bad-stop.json',s.canonicalStop);}
 if(fault==='repeated-send')d.sameAcceptedSendMustNotRepeat=false;
 if(fault==='reset-journal'||fault==='journal-pending'){const j=JSON.parse(await fs.readFile(s.journalPin.path,'utf8'));if(fault==='reset-journal')j.providerCalls=0;else j.pending=[{}];await fs.writeFile(s.journalPin.path,JSON.stringify(j));d.checkpointJournal={...s.journalPin,sha256:h(JSON.stringify(j))};}
 if(fault==='wrong-owner')d.acceptedReceipt.senderRole='je1';if(fault==='operation-refund')d.operations=33;
 if(fault==='model-uncertain'){const v=JSON.parse(await fs.readFile(d.accounting.path,'utf8'));v.counts.unresolvedDispatches=1;d.accounting=await s.pin('accepted-uncertain.json',v);}
 if(fault==='live-port'){const v=JSON.parse(await fs.readFile(d.cleanup.path,'utf8'));v.ports[0].listening=true;d.cleanup=await s.pin('accepted-live-port.json',v);}
 if(fault==='changed-old-journal')await fs.appendFile(s.journal.path,' ');if(fault==='missing-allocation')delete r.operationAmendment;
 if(fault==='clock-extension')o.receipt.hardStopUtc=new Date(Date.parse(o.receipt.hardStopUtc)+1).toISOString();
 await s.refreshAccepted();if(fault==='descriptor-drift')await fs.appendFile(r.acceptedCheckpoint.path,' ');
 const before=await fs.readFile(s.filename),actions=await fs.readFile(path.join(s.root,'phase-c-cumulative-actions.jsonl'));await expect(ContinuationController.prepareControlledProgress(o)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);expect(await fs.readFile(path.join(s.root,'phase-c-cumulative-actions.jsonl'))).toEqual(actions);
});
it('makes historical prefix inspection read-only, exact and anchored in the actual cumulative ledger',async()=>{
 const s=await acceptedCheckpointSetup(),ledger=await RequestBudgetLedger.open(s.filename),pin=s.options.recovery.startupStops.at(-1).ledger,before=await fs.readFile(pin.path);
 const view=await ledger.inspectReadOnlyPrefix(pin.path,pin.sha256);expect(view.snapshot().chargedAttempts).toBe(35);
 const earlier=s.options.recovery.ledger,nested=await view.inspectReadOnlyPrefix(earlier.path,earlier.sha256);expect(nested.snapshot().chargedAttempts).toBe(35);
 await expect(nested.bindApprovedWindow(h('nested write'),{approvalReceiptHash:h('fake'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:35})).rejects.toThrow('READ_ONLY_LEDGER_PREFIX');
 await expect(view.inspectReadOnlyPrefix(s.filename,ledger.contentSha256)).rejects.toThrow('EXACT_READ_ONLY_LEDGER_PREFIX_REQUIRED');
 await expect(view.bindApprovedWindow(h('attempted prefix write'),{approvalReceiptHash:h('fake'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:35})).rejects.toThrow('READ_ONLY_LEDGER_PREFIX');
 expect(await fs.readFile(pin.path)).toEqual(before);await expect(fs.access(pin.path+'.lock')).rejects.toMatchObject({code:'ENOENT'});
 const foreign=await s.pin('foreign-prefix.jsonl',before.toString().replace('"previous"','"changed"'));await expect(ledger.inspectReadOnlyPrefix(foreign.path,foreign.sha256)).rejects.toThrow('EXACT_READ_ONLY_LEDGER_PREFIX_REQUIRED');
});

async function acceptedConfigurationStopSetup(){
 const s=await acceptedCheckpointSetup(),o=s.options,r=o.recovery,now=Date.now()+2000,priorPin=r.acceptedCheckpoint,priorJournal=await fs.readFile(s.journalPin.path),canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 vi.spyOn(Date,'now').mockReturnValue(now);
 const p=JSON.parse(await fs.readFile(r.targetPacket.path,'utf8'));p.directory=path.join(s.root,'configuration-stop-session');p.sealPath=path.join(s.root,'configuration-stop-seal.json');p.states={openclaw:path.dirname(path.dirname(s.journalPin.path))};p.nativeBoundary={nativeSourceSha256:h('inert native')};p.decisionPaths={adoption:path.join(p.directory,'adoption.json')};p.controlledRecoveryBase=structuredClone(r);
 const packet=await s.pin('configuration-stop-packet.json',p),seal=await s.pin('configuration-stop-seal.json',{packet});
 const adoption={...s.adoption,currentCanonicalMessages:14,packetSha256:packet.sha256,decisionId:'configuration-stop-actual-window',receivedAtUtc:new Date(now-1).toISOString(),timeMode:'new-interval'};
 await fs.mkdir(p.directory,{recursive:true});await fs.writeFile(p.decisionPaths.adoption,JSON.stringify(adoption));r.adoption={path:p.decisionPaths.adoption,sha256:h(JSON.stringify(adoption))};r.targetPacket=packet;
 o.receipt={...o.receipt,packetSha256:packet.sha256,approvalReceiptSha256:r.adoption.sha256,startUtc:new Date(now).toISOString(),hardStopUtc:new Date(now+5400000).toISOString()};o.expected={...o.expected,packetSha256:packet.sha256};
 const inventory=JSON.parse(await fs.readFile(r.history.currentInventory.path,'utf8'));inventory.checkedAt=new Date(now).toISOString();inventory.canonicalMessageEffects=14;r.history.currentInventory=await s.pin('configuration-start-inventory.json',inventory);const cw=JSON.parse(await fs.readFile(r.canonicalWork.path,'utf8'));cw.checkedAt=inventory.checkedAt;r.canonicalWork=await s.pin('configuration-start-canonical.json',cw);o.preflight.checkedAtMs=now;o.preflight.canonicalEffects=14;
 let signed=s.sign(s.nextGraph,o.receipt,'configuration start');o.reviewedPlan=signed.plan;o.graphApprovalRaw=signed.raw;
 const before=await ContinuationController.prepareControlledProgress(o),c=await ContinuationController.startControlledProgress(before);c.stop();
 const window=h(JSON.stringify(o.receipt)),execution={purpose:'actual-controlled-checkpoint-recovery',receipt:o.receipt,window,graphApprovalRaw:o.graphApprovalRaw,priorExecution:s.descriptor.execution,carriedState:r.state,carriedCheckpoint:r.carry,sealSha256:seal.sha256,actualStartedAtUtc:o.receipt.startUtc};
 const executionPin=await s.pin('configuration-stop-execution.json',execution),state={...structuredClone(s.acceptedState),window,planSha256:h(JSON.stringify(canon({...p.program,windowId:window})))};
 const journal=JSON.parse(priorJournal.toString());journal.providerCalls=2;journal.input.push({role:'user',content:JSON.stringify({notice:'Fresh canonical state after host recovery; earlier history is context, not authority.',context:{},snapshot:{}})});await fs.writeFile(s.journalPin.path,JSON.stringify(journal));
 const deadline=new Date(now+120000).toISOString(),decision=(subjectHash:string,purpose:string)=>({version:1,purpose,ownerApproved:true,window,clientSource:p.clientSource,subjectHash,nativeSourceSha256:p.nativeBoundary.nativeSourceSha256,approvedAtUtc:new Date(now+100).toISOString(),expiresAtUtc:deadline}),target=decision(h('target'),'phase-c-personal-native-target-selection'),capability=decision(h('capability'),'closed-openclaw-core-anthropic-capability');
 const q:any={database:'sinaloa_staging',readOnly:'on',checkedAt:new Date(now+1500).toISOString(),activeWorkLeases:0,activeCaseSessions:0,caseState:'inProgress',work:[{...s.newWork,attempts:2},s.oldWork],sessions:[{workId:s.workId,status:'ended'},{workId:s.oldWork.workId,status:'ended'}]};
 const d:any={purpose:'actual-v3-post-target-pre-model-stop-inspection',version:1,executionAllowed:false,newAuthorityGranted:false,checkedAtUtc:new Date(now+2000).toISOString(),window,fixedHardStopUtc:o.receipt.hardStopUtc,source:p.clientSource,packet,seal,execution:executionPin,
  stop:await s.pin('configuration-stop.json',{state:'controlled_recovery_stopped_preserve_originals',phase:'remaining-native-program',observedAtUtc:new Date(now+1000).toISOString(),packetSha256:packet.sha256,gateComplete:false}),programState:await s.pin('configuration-state.json',state),failure:await s.pin('configuration-failure.log','inert ownedNativeStartupError ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED'),priorAcceptedCheckpoint:priorPin,
  previousJournal:await s.pin('configuration-prior-journal.json',priorJournal.toString()),previousJournalReconstruction:await s.pin('configuration-reconstruction.json',{matchedExactKnownWholeFileHash:true,currentCanonicalJournalUnchanged:true,noAuthorityGranted:true,noReplayAttempted:true}),checkpointJournal:await s.pin('configuration-current-journal.json',JSON.stringify(journal)),canonicalCheckpointJournalPath:s.journalPin.path,
  frozenRequests:await s.pin('configuration-requests.jsonl',await fs.readFile(s.filename,'utf8')),frozenActions:await s.pin('configuration-actions.jsonl',await fs.readFile(path.join(s.root,'phase-c-cumulative-actions.jsonl'),'utf8')),
  personalTargetRequest:await s.pin('configuration-target-request.json',{purpose:'phase-c-personal-native-target-batch',version:1,window,clientSource:p.clientSource,hardStopUtc:deadline,targets:[{workId:s.workId,targetDecisionTemplate:{purpose:target.purpose,subjectHash:target.subjectHash},capabilityDecisionTemplate:{purpose:capability.purpose,subjectHash:capability.subjectHash}}]}),personalTargetResponse:await s.pin('configuration-target-response.json',{purpose:'phase-c-personal-native-target-batch-result',window,results:[{workId:s.workId,targetDecisionRaw:JSON.stringify(target),capabilityDecisionRaw:JSON.stringify(capability)}]}),personalTargetDecisions:await s.pin('configuration-decisions.json',{workId:s.workId,target,capability}),targetReviewCompleted:true,
  nativeStartupDiagnostic:{version:1,stage:'configuration',reason:'ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED'},currentCheckpoint:{workId:s.workId,caseId:s.caseId,providerCalls:2,inputCount:3,completed:false,pending:0},canonicalFreshOwnerRead:await s.pin('configuration-canonical-stop.json',q),missingCanonicalFields:[],nativePhysicalRequestsAdded:0,knownNativeDispatchedAdded:0,models:35,pending:0,unresolvedDispatches:0,operations:34,assets:0,results:0,effects:0,oldFailedJournalUnchanged:true,
  physicalPorts:await s.pin('configuration-ports.json',{checkedAtUtc:new Date(now+1500).toISOString(),results:[{listening:false,state:'ECONNREFUSED'},{listening:false,state:'ECONNREFUSED'}],processesSignaled:0,modelCallsAdded:0}),physicalProcesses:await s.pin('configuration-processes.json',{checkedAtUtc:new Date(now+1500).toISOString(),nativeChildCount:0,originalOperatorGone:true,modelsAdded:0}),originalAdmissionMustNotReplay:true,acceptedSendMustNotRepeat:true,targetReviewMustNotBeRepeatedAsOldApproval:true,noRecoveryAttempted:true};
 vi.spyOn(Date,'now').mockReturnValue(now+2000);r.acceptedCheckpoint=await s.pin('configuration-stop-descriptor.json',d);r.history.actionLedger=d.frozenActions;
 const future=await s.pin('configuration-repaired-target.json',{...p,clientSource:'5'.repeat(40),library:{sha256:h('configuration repaired library')}});r.targetPacket=future;
 const next:any={...adoption,priorWindow:window,priorExecutionSha256:executionPin.sha256,priorLedgerSha256:d.frozenRequests.sha256,acceptedCheckpointSha256:r.acceptedCheckpoint.sha256,clientSource:'5'.repeat(40),runnerSha256:h('configuration repaired library'),packetSha256:future.sha256,decisionId:'configuration-repaired-same-fixed-window',receivedAtUtc:new Date(now+1900).toISOString(),timeMode:'same-fixed'};
 inventory.checkedAt=new Date(now+2000).toISOString();r.history.currentInventory=await s.pin('configuration-repaired-inventory.json',inventory);r.canonicalWork=await s.pin('configuration-repaired-canonical.json',{database:'sinaloa_staging',readOnly:'on',checkedAt:inventory.checkedAt,activeWorkLeases:0,activeCaseSessions:0,work:{...q.work[0],caseId:s.caseId,agentId:o.actorIds.openclaw,sessions:[{status:'ended'}]},retainedOriginal:{...s.oldWork,caseId:s.caseId,agentId:o.actorIds.openclaw}});o.preflight.checkedAtMs=now+2000;
 o.receipt={...o.receipt,clientSource:next.clientSource,ciHead:next.clientSource,runnerSha256:next.runnerSha256,packetSha256:future.sha256};o.expected={...o.expected,clientSource:next.clientSource,runnerSha256:next.runnerSha256,packetSha256:future.sha256};
 const refresh=async()=>{r.acceptedCheckpoint=await s.pin('configuration-stop-descriptor.json',d);next.acceptedCheckpointSha256=r.acceptedCheckpoint.sha256;r.adoption=await s.pin('configuration-repaired-adoption.json',next);o.receipt.approvalReceiptSha256=r.adoption.sha256;const proof=s.sign(s.nextGraph,o.receipt,'configuration repaired');o.reviewedPlan=proof.plan;o.graphApprovalRaw=proof.raw;};await refresh();return{...s,d,q,currentJournal:journal,next,refresh,priorJournal,configurationReceipt:execution.receipt};
}
it('preserves an actual configuration refusal while preparing a fresh claim of the same accepted work in the same fixed window',async()=>{const s=await acceptedConfigurationStopSetup(),bytes=await fs.readFile(s.filename),journal=await fs.readFile(s.journalPin.path),failed=await fs.readFile(s.journal.path);const handle=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(bytes);const c=await ContinuationController.startControlledProgress(handle);expect(c.receipt.startUtc).toBe(s.configurationReceipt.startUtc);expect(c.receipt.hardStopUtc).toBe(s.configurationReceipt.hardStopUtc);expect(c.ledger.snapshot().chargedAttempts).toBe(35);expect(await fs.readFile(s.journalPin.path)).toEqual(journal);expect(await fs.readFile(s.journal.path)).toEqual(failed);c.stop();});
it.each(['missing-canonical','attempt-reset','active-lease','processed','physical-request','wrong-diagnostic','repeated-send','target-not-reviewed','journal-prefix','live-port','extended-clock','invalid-time','future-port-proof','wrong-target-purpose','diagnostic-evidence'] as const)('refuses altered configuration-stop recovery before mutation: %s',async fault=>{const s=await acceptedConfigurationStopSetup();
 if(fault==='missing-canonical')s.d.canonicalFreshOwnerRead=null;if(fault==='attempt-reset'||fault==='active-lease'||fault==='processed'){if(fault==='attempt-reset')s.q.work[0].attempts=1;if(fault==='active-lease')s.q.activeWorkLeases=1;if(fault==='processed')s.q.work[0].processedAt=new Date(Date.now()).toISOString();s.d.canonicalFreshOwnerRead=await s.pin('configuration-bad-canonical.json',s.q);}
 if(fault==='physical-request')s.d.nativePhysicalRequestsAdded=1;if(fault==='wrong-diagnostic')s.d.nativeStartupDiagnostic.reason='INVALID_CONFIG';if(fault==='repeated-send')s.d.acceptedSendMustNotRepeat=false;if(fault==='target-not-reviewed')s.d.targetReviewCompleted=false;
 if(fault==='journal-prefix')await fs.appendFile(s.d.previousJournal.path,' ');if(fault==='live-port')s.d.physicalPorts=await s.pin('configuration-bad-ports.json',{checkedAtUtc:new Date(Date.now()).toISOString(),results:[{listening:true,state:'OPEN'},{listening:false,state:'ECONNREFUSED'}],processesSignaled:0,modelCallsAdded:0});if(fault==='extended-clock')s.options.receipt.hardStopUtc=new Date(Date.parse(s.options.receipt.hardStopUtc)+1).toISOString();
 if(fault==='invalid-time')s.d.checkedAtUtc='invalid';if(fault==='future-port-proof')s.d.physicalPorts=await s.pin('configuration-future-ports.json',{checkedAtUtc:new Date(Date.now()+1000).toISOString(),results:[{listening:false,state:'ECONNREFUSED'},{listening:false,state:'ECONNREFUSED'}],processesSignaled:0,modelCallsAdded:0});if(fault==='wrong-target-purpose'){const target=JSON.parse(await fs.readFile(s.d.personalTargetResponse.path,'utf8'));const decision=JSON.parse(target.results[0].targetDecisionRaw);decision.purpose='foreign-purpose';target.results[0].targetDecisionRaw=JSON.stringify(decision);s.d.personalTargetResponse=await s.pin('configuration-wrong-purpose.json',target);}if(fault==='diagnostic-evidence')s.d.failure=await s.pin('configuration-diagnostic-missing.log','different error');
 await s.refresh();const ledger=await fs.readFile(s.filename),journal=await fs.readFile(s.journalPin.path);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(ledger);expect(await fs.readFile(s.journalPin.path)).toEqual(journal);
});

async function ownerTargetTimeoutBase(){return{...await acceptedConfigurationStopSetup(),timeoutLayer:0};}
async function ownerTargetTimeoutSetup(previous?:Awaited<ReturnType<typeof ownerTargetTimeoutBase>>){
 const s=previous??await ownerTargetTimeoutBase(),layer=(s.timeoutLayer??0)+1,pin=(name:string,value:unknown)=>s.pin(`timeout-${layer}-${name}`,value),o=s.options,r=o.recovery,now=Date.now()+1000,prior=r.acceptedCheckpoint,priorExecution=s.d.execution;
 const p=JSON.parse(await fs.readFile(r.targetPacket.path,'utf8'));p.program={...p.program,clientSource:p.clientSource,serverSource:p.serverSource};p.directory=path.join(s.root,'owner-timeout-runtime-'+layer);p.sealPath=path.join(s.root,'timeout-'+layer+'-owner-timeout-seal.json');p.decisionPaths={adoption:r.adoption.path};p.controlledRecoveryBase=structuredClone(r);p.actors={...p.actors,openclaw:{agentId:o.actorIds.openclaw,installationId:'installation_inert'}};
 const packet=await pin('owner-timeout-packet.json',p),seal=await pin('owner-timeout-seal.json',{packet});r.targetPacket=packet;s.next.packetSha256=packet.sha256;o.receipt={...o.receipt,packetSha256:packet.sha256};o.expected={...o.expected,packetSha256:packet.sha256};await s.refresh();
 const c=await ContinuationController.startControlledProgress(await ContinuationController.prepareControlledProgress(o));c.stop('INERT_OWNER_TIMEOUT');
 const window=h(JSON.stringify(o.receipt)),execution={purpose:'actual-controlled-checkpoint-recovery',receipt:o.receipt,window,graphApprovalRaw:o.graphApprovalRaw,priorExecution,carriedState:r.state,carriedCheckpoint:r.carry,sealSha256:seal.sha256,actualStartedAtUtc:new Date(now).toISOString()},executionPin=await pin('owner-timeout-execution.json',execution);
 const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 const state={...JSON.parse(await fs.readFile(s.d.programState.path,'utf8')),window,planSha256:h(JSON.stringify(canon({...p.program,windowId:window})))};
 const deadline=new Date(now+1000).toISOString(),stopped=new Date(now+2000).toISOString(),checked=new Date(now+2500).toISOString();
 const template=(purpose:string)=>({version:1,purpose,ownerApproved:false,window,clientSource:p.clientSource,nativeSourceSha256:p.nativeBoundary.nativeSourceSha256,subjectHash:h(purpose),expiresAtUtc:deadline});
 const response=path.join(p.directory,'owner-requests','native-'+h('inert unanswered target')+'.owner.json');await fs.mkdir(path.dirname(response),{recursive:true});
 const request={purpose:'phase-c-personal-native-target-batch',version:1,window,clientSource:p.clientSource,hardStopUtc:deadline,receiptPath:response,targets:[{workId:s.workId,hardStopUtc:deadline,safeDisplay:{gatewayOrigin:'http://127.0.0.1:43101'},targetDecisionTemplate:template('phase-c-personal-native-target-selection'),capabilityDecisionTemplate:template('closed-openclaw-core-anthropic-capability')}]};
 const session={id:'case_session_inert_timeout_'+layer,fence:layer+2,agentId:o.actorIds.openclaw,installationId:'installation_inert'};
 const event=(kind:string,delta:number,data:any={})=>({atUtc:new Date(now+delta).toISOString(),window,kind,...data});
 const snapshot=JSON.stringify({case:{id:s.caseId},messages:[{id:s.workId,caseId:s.caseId}]});
 const events=[event('actual_session_started_awaiting_personal_gateway_addresses',0,{modelCalls:35,onboardingRepeated:false,acceptedSendsRepeated:false}),event('owned_native_factory_ready',100,{nativeGatewayStarted:false,modelPromptsSubmitted:0}),event('existing_receiver_ready',200),event('prior_openclaw_controls_carried_without_repetition',300),event('prior_openclaw_poll_gap_carried_without_repetition',400),event('actual_canonical_context',500,{flowId:'openclaw',role:'openclaw',workId:s.workId,caseId:s.caseId,session}),event('actual_bounded_case_snapshot',600,{workId:s.workId,caseId:s.caseId,rawSnapshotBytes:snapshot,sha256:h(snapshot)}),event('receiver_startup_transport_failure',1100),event('canonical_settlement',1200,{role:'openclaw',workId:s.workId,status:'retryable',operation:'fail'})];
 const q:any={...s.q,checkedAt:checked,work:[{...s.q.work[0],attempts:layer+2},s.oldWork],sessions:[...s.q.sessions,{workId:s.workId,id:session.id,fence:session.fence,status:'ended'}]};
 const d:any={purpose:'actual-accepted-checkpoint-owner-target-timeout-stop',version:1,checkedAtUtc:checked,executionAllowed:false,newAuthorityGranted:false,source:p.clientSource,server:p.serverSource,packet,seal,priorAcceptedCheckpoint:prior,execution:executionPin,
  stop:await pin('owner-timeout-stop.json',{state:'controlled_recovery_stopped_preserve_originals',phase:'remaining-native-program',observedAtUtc:stopped,packetSha256:packet.sha256,gateComplete:false}),failure:await pin('owner-timeout-error.log','DOMException [TimeoutError]: The operation was aborted due to timeout\ninert evidence'),events:await pin('owner-timeout-events.jsonl',events.map(x=>JSON.stringify(x)+'\n').join('')),programState:await pin('owner-timeout-state.json',state),personalTargetRequest:await pin('owner-timeout-request.json',request),personalTargetResponseAbsent:true,ownerReviewCompleted:false,targetDeadlineUtc:deadline,window,fixedHardStopUtc:o.receipt.hardStopUtc,canonicalSettlementAcknowledgement:events.at(-1),checkpointJournal:await pin('owner-timeout-frozen-journal.json',await fs.readFile(s.journalPin.path,'utf8')),canonicalCheckpointJournalPath:s.journalPin.path,checkpointJournalUnchanged:true,providerCalls:2,inputCount:3,models:35,physicalOpenClawAdded:0,operations:34,assets:0,results:0,effects:0,
  frozenRequests:await pin('owner-timeout-requests.jsonl',await fs.readFile(s.filename,'utf8')),frozenActions:s.d.frozenActions,
  physicalPorts:await pin('owner-timeout-ports.json',{checkedAtUtc:checked,ports:[{origin:'http://127.0.0.1:43101',listening:false,state:'ECONNREFUSED'},{origin:'http://127.0.0.1:43102',listening:false,state:'ECONNREFUSED'}],processesSignaled:0,modelsAdded:0}),physicalProcesses:await pin('owner-timeout-processes.json',{checkedAtUtc:checked,nativeChildCount:0,originalOperatorGone:true,processesSignaled:0,modelsAdded:0}),canonicalFreshOwnerRead:await pin('owner-timeout-canonical.json',q),missingCanonicalFields:[],acceptedSendMustNotRepeat:true,oldFailedTaskMustNotReplay:true,oldTargetDeadlineMustNotMove:true,noRecoveryAttempted:true};
 vi.spyOn(Date,'now').mockReturnValue(now+3000);r.acceptedCheckpoint=await pin('owner-timeout-descriptor.json',d);r.history.actionLedger=d.frozenActions;
 const target=await pin('owner-timeout-repair-packet.json',{...p,clientSource:'6'.repeat(40),library:{sha256:h('timeout repair library')},program:{...p.program,clientSource:'6'.repeat(40)}});r.targetPacket=target;
 const adoption:any={...s.next,priorWindow:window,priorExecutionSha256:executionPin.sha256,priorLedgerSha256:d.frozenRequests.sha256,acceptedCheckpointSha256:r.acceptedCheckpoint.sha256,clientSource:'6'.repeat(40),runnerSha256:h('timeout repair library'),packetSha256:target.sha256,decisionId:'inert-owner-timeout-same-fixed-'+layer,receivedAtUtc:new Date(now+2900).toISOString(),timeMode:'same-fixed'};
 o.receipt={...o.receipt,clientSource:adoption.clientSource,ciHead:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:target.sha256};o.expected={...o.expected,clientSource:adoption.clientSource,runnerSha256:adoption.runnerSha256,packetSha256:target.sha256};
 const inventory=JSON.parse(await fs.readFile(r.history.currentInventory.path,'utf8'));inventory.checkedAt=checked;r.history.currentInventory=await pin('owner-timeout-fresh-inventory.json',inventory);o.preflight.checkedAtMs=Date.parse(checked);
 r.canonicalWork=await pin('owner-timeout-fresh-work.json',{database:q.database,readOnly:q.readOnly,checkedAt:checked,activeWorkLeases:0,activeCaseSessions:0,work:{...q.work[0],caseId:s.caseId,agentId:o.actorIds.openclaw,sessions:q.sessions.filter((x:any)=>x.workId===s.workId)},retainedOriginal:{...s.oldWork,caseId:s.caseId,agentId:o.actorIds.openclaw}});
 const refresh=async()=>{r.acceptedCheckpoint=await pin('owner-timeout-descriptor.json',d);adoption.acceptedCheckpointSha256=r.acceptedCheckpoint.sha256;r.adoption=await pin('owner-timeout-repair-adoption.json',adoption);o.receipt.approvalReceiptSha256=r.adoption.sha256;const proof=s.sign(s.nextGraph,o.receipt,'owner target timeout repair');o.reviewedPlan=proof.plan;o.graphApprovalRaw=proof.raw;};await refresh();return{...s,d,q,request,response,events,adoption,next:adoption,timeoutLayer:layer,refresh,currentReceipt:execution.receipt};
}

it('carries a real expired unapproved target review with the same fixed deadline and separate claim/journal counters',async()=>{
 const s=await ownerTargetTimeoutSetup(),ledger=await fs.readFile(s.filename),journal=await fs.readFile(s.journalPin.path),failed=await fs.readFile(s.journal.path),h=await ContinuationController.prepareControlledProgress(s.options);expect(await fs.readFile(s.filename)).toEqual(ledger);
 const c=await ContinuationController.startControlledProgress(h);expect(c.receipt.startUtc).toBe(s.currentReceipt.startUtc);expect(c.receipt.hardStopUtc).toBe(s.currentReceipt.hardStopUtc);expect(c.ledger.snapshot().chargedAttempts).toBe(35);expect(await fs.readFile(s.journalPin.path)).toEqual(journal);expect(JSON.parse(journal.toString()).providerCalls).toBe(2);expect(await fs.readFile(s.journal.path)).toEqual(failed);c.stop();
});
it.each(['missing-canonical','attempt-reset','attempt-jump','active-lease','processed','session-active','old-failure-revived','late-response','approved-template','deadline-moved','physical-request','journal-changed','extra-event','wrong-cause','live-port','clock-extension'] as const)('refuses unsafe owner-target-timeout carry before mutation: %s',async fault=>{
 const s=await ownerTargetTimeoutSetup();if(fault==='missing-canonical')s.d.canonicalFreshOwnerRead=null;
 if(['attempt-reset','attempt-jump','active-lease','processed','session-active','old-failure-revived'].includes(fault)){if(fault==='attempt-reset')s.q.work[0].attempts=2;if(fault==='attempt-jump')s.q.work[0].attempts=4;if(fault==='active-lease')s.q.activeWorkLeases=1;if(fault==='processed')s.q.work[0].processedAt=new Date(Date.now()).toISOString();if(fault==='session-active')s.q.sessions.at(-1).status='active';if(fault==='old-failure-revived')s.q.work[1]={...s.q.work[1],status:'retryable'};s.d.canonicalFreshOwnerRead=await s.pin('owner-timeout-bad-canonical.json',s.q);}
 if(fault==='late-response')await fs.writeFile(s.response,JSON.stringify({ownerApproved:true}));if(fault==='approved-template'){s.request.targets[0].targetDecisionTemplate.ownerApproved=true;s.d.personalTargetRequest=await s.pin('owner-timeout-bad-request.json',s.request);}if(fault==='deadline-moved')s.d.targetDeadlineUtc=new Date(Date.parse(s.d.targetDeadlineUtc)+1).toISOString();if(fault==='physical-request')s.d.physicalOpenClawAdded=1;if(fault==='journal-changed')await fs.appendFile(s.journalPin.path,' ');if(fault==='extra-event'){s.events.push({...s.events.at(-1),kind:'native_prompt_submitted'});s.d.events=await s.pin('owner-timeout-bad-events.jsonl',s.events.map(x=>JSON.stringify(x)+'\n').join(''));}if(fault==='wrong-cause')s.d.failure=await s.pin('owner-timeout-wrong-cause.log','ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED');if(fault==='live-port')s.d.physicalPorts=await s.pin('owner-timeout-live-port.json',{checkedAtUtc:new Date(Date.now()).toISOString(),ports:[{origin:'http://127.0.0.1:43101',listening:true,state:'OPEN'},{origin:'http://127.0.0.1:43102',listening:false,state:'ECONNREFUSED'}],processesSignaled:0,modelsAdded:0});if(fault==='clock-extension')s.options.receipt.hardStopUtc=new Date(Date.parse(s.options.receipt.hardStopUtc)+1).toISOString();
 await s.refresh();const ledger=await fs.readFile(s.filename),journal=await fs.readFile(s.journalPin.path);await expect(ContinuationController.prepareControlledProgress(s.options)).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(ledger);expect(await fs.readFile(s.journalPin.path)).toEqual(journal);
});

it('carries a second settled review timeout at attempt four without resetting the original window',async()=>{const first=await ownerTargetTimeoutSetup(),second=await ownerTargetTimeoutSetup(first),before=await fs.readFile(second.filename),handle=await ContinuationController.prepareControlledProgress(second.options);expect(await fs.readFile(second.filename)).toEqual(before);const c=await ContinuationController.startControlledProgress(handle);expect(c.receipt.hardStopUtc).toBe(first.currentReceipt.hardStopUtc);expect(c.ledger.snapshot().chargedAttempts).toBe(35);expect(JSON.parse(await fs.readFile(second.journalPin.path,'utf8')).providerCalls).toBe(2);c.stop();});

it('refuses to carry a third review timeout as retryable attempt five',async()=>{const first=await ownerTargetTimeoutSetup(),second=await ownerTargetTimeoutSetup(first),third=await ownerTargetTimeoutSetup(second),before=await fs.readFile(third.filename);await expect(ContinuationController.prepareControlledProgress(third.options)).rejects.toThrow();expect(await fs.readFile(third.filename)).toEqual(before);});
