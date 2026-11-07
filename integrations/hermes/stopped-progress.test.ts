import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {ContinuationController,type ContinuationReceipt} from './continuation-controller';
import {RequestBudgetLedger} from './request-budget';
import {continuationAllocation,defaultContinuationFlowPolicy,hashReviewedContinuationPlan,type ReviewedContinuationPlan} from './continuation-plan';
import {authorizeRecoveryTime} from './recovery-time';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),h=(v:string)=>hash(v),dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)){if(!path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(dir).startsWith('envoi-progress-test-'))throw Error('CLEANUP_REFUSED');await fs.rm(dir,{recursive:true,force:true});}});
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
 const recovery={purpose:'phase-c-stopped-native-progress' as const,priorExecution:await pin('old-execution.json',{window:original.ledger.window,receipt:old,packetSha256:old.packetSha256,graphApproval:JSON.parse(oldSigned.raw)}),priorPacket,priorState:await pin('old-state.json',state),priorLedger:await pin('old-ledger.jsonl',prefix),stop:await pin('old-stop.json',{state:'stopped',command:'stop',appliedAtUtc:new Date().toISOString()}),actionLedger:await pin('actions-snapshot.jsonl',actions),currentInventory,completed,failed,time:{mode:'same-fixed' as const}};
 const receipt:ContinuationReceipt={...old,clientSource:'d'.repeat(40),ciHead:'d'.repeat(40),packetSha256:h('new packet'),runnerSha256:h('new library'),approvalReceiptSha256:h('new approval'),startUtc:new Date(Date.now()-1000).toISOString()};
 const nextGraph={...graph,flows:[...flows.map(f=>['private-backlog','green','asset-read-proposal'].includes(f.id)?{...f,retired:true as const}:f),{id:'new-private-review',role:'je1' as const,requests:1,workHash:null,policy:{noAction:true,decisionOutcome:null,allowHumanEnd:false}}],flowCases:{...flowCases,'new-private-review':flowCases[used[2]]}},signed=sign(nextGraph,receipt,'new');
 const options={releaseRoot:root,receipt,preflight:{checkedAtMs:Date.parse(checkedAt),allSelectedHostsStopped:true as const,activeLeases:0 as const,protectedCasePaused:true as const,originalDispositionMatches:true as const,actualHermesCalls:29,actualOpenClawCalls:6,conservativeMessages:32,canonicalEffects:12,cases:4,newInstallations:5 as const,assets:0},expected:{clientSource:receipt.clientSource,serverSource:receipt.serverSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256,priorLedgerSha256:historical.sha256},flowCases:nextGraph.flowCases,actorIds:actors,reviewedPlan:signed.plan,graphApprovalRaw:signed.raw,recovery};
 return{root,pin,original,filename,prefix,state,options,nextGraph,sign,proof,used};
}
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
