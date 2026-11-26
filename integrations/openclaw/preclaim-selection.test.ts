import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {approveOpenClawPreclaim,assertOpenClawPreclaim,bindOpenClawPreclaim,openClawPreclaimDigest,openClawPreclaimReceiptSha256,readOpenClawPreclaimSelection,type OpenClawPreclaimTarget} from './preclaim-selection';
import {openClawTargetDigest,type OpenClawWorkTarget} from './scoped-target';
const h=(s:string)=>createHash('sha256').update(s).digest('hex');
afterEach(()=>vi.restoreAllMocks());
function setup(){
 const stop=new AbortController(),target:OpenClawPreclaimTarget={binding:{window:h('workflow'),workId:'msg_same_accepted',caseId:'case_same',recipientAgentId:'agent_same',installationId:'installation_same'},clientSource:'a'.repeat(40),nativeSourceSha256:h('native'),inboxId:'inbox_same',factoryPolicySha256:h('factory-policy'),modelId:'claude-haiku-4-5-20251001',gatewayUrl:'http://127.0.0.1:41001',gatewayToken:'FAKE_PRIVATE_TOKEN',agentId:'main',processIdentity:'native_process',configurationSha256:h('config'),stateDirectorySha256:h('state'),configurationPathSha256:h('path'),workspaceSha256:h('workspace'),agentStateSha256:h('agent-state'),proxyOrigin:'http://127.0.0.1:41002',proxyIdentity:'proxy_owned'};
 const raw=JSON.stringify({purpose:'phase-c-personal-preclaim-native-selection',version:1,ownerApproved:true,lifetime:'one-claim-until-cancel',subjectHash:openClawPreclaimDigest(target),window:target.binding.window,clientSource:target.clientSource,nativeSourceSha256:target.nativeSourceSha256,approvedAtUtc:new Date().toISOString()});
 const approval=approveOpenClawPreclaim(target,raw,stop.signal);
 const bind=():OpenClawWorkTarget=>({...target,binding:{...target.binding,caseSessionId:'case_session_fresh',fence:4},deadlineUnixMs:Date.now()+120000,toolChannelSha256:h('actual secret scoped transport'),ownerSelectionSha256:openClawPreclaimReceiptSha256(approval)});
 return{stop,target,raw,approval,bind};
}
it('keeps preclaim human review valid after days, then derives exactly one fresh finite target',()=>{
 const s=setup(),later=Date.now()+3*86400000;vi.spyOn(Date,'now').mockReturnValue(later);
 assertOpenClawPreclaim(s.approval,{...s.target.binding,clientSource:s.target.clientSource});
 expect(()=>readOpenClawPreclaimSelection(s.approval)).toThrow();
 const target=s.bind(),receipt=bindOpenClawPreclaim(s.approval,target);
 expect(receipt).toMatchObject({receiptSha256:h(s.raw),caseSessionId:'case_session_fresh',toolChannelSha256:target.toolChannelSha256,targetSha256:openClawTargetDigest(target)});
 expect(()=>bindOpenClawPreclaim(s.approval,{...target,binding:{...target.binding,fence:5}})).toThrow();
 expect(()=>assertOpenClawPreclaim(s.approval,{...s.target.binding,clientSource:s.target.clientSource})).toThrow();
 vi.mocked(Date.now).mockReturnValue(later+120001);expect(()=>readOpenClawPreclaimSelection(s.approval)).toThrow();
});
it.each(['case','work','agent','installation','window','config','state','workspace','port','token','proxy','process','tool','session','fence','expired','extended','receipt'] as const)('refuses changed static or invalid fresh native scope: %s',fault=>{
 const s=setup();vi.spyOn(Date,'now').mockReturnValue(Date.now());const t=s.bind();
 if(fault==='case')t.binding={...t.binding,caseId:'case_other'};if(fault==='work')t.binding={...t.binding,workId:'msg_other'};if(fault==='agent')t.binding={...t.binding,recipientAgentId:'agent_other'};if(fault==='installation')t.binding={...t.binding,installationId:'installation_other'};if(fault==='window')t.binding={...t.binding,window:h('other')};
 if(fault==='config')t.configurationSha256=h('other');if(fault==='state')t.stateDirectorySha256=h('other');if(fault==='workspace')t.workspaceSha256=h('other');if(fault==='port')t.gatewayUrl='http://127.0.0.1:41003';if(fault==='token')t.gatewayToken='OTHER_FAKE_TOKEN';if(fault==='proxy')t.proxyOrigin='http://127.0.0.1:41004';if(fault==='process')t.processIdentity='other';if(fault==='tool')t.toolChannelSha256='';if(fault==='session')t.binding={...t.binding,caseSessionId:''};if(fault==='fence')t.binding={...t.binding,fence:0};if(fault==='expired')t.deadlineUnixMs=Date.now();if(fault==='extended')t.deadlineUnixMs=Date.now()+120001;if(fault==='receipt')t.ownerSelectionSha256=h('other');
 expect(()=>bindOpenClawPreclaim(s.approval,t)).toThrow();
});
it.each(['legacy','unapproved','expiry','future','wrong-source','wrong-native','subject'] as const)('does not convert old/ambiguous permission into preclaim consent: %s',fault=>{
 const s=setup(),v=JSON.parse(s.raw);if(fault==='legacy')v.purpose='phase-c-personal-native-target-selection';if(fault==='unapproved')v.ownerApproved=false;if(fault==='expiry')v.expiresAtUtc=new Date().toISOString();if(fault==='future')v.approvedAtUtc=new Date(Date.now()+100000).toISOString();if(fault==='wrong-source')v.clientSource='b'.repeat(40);if(fault==='wrong-native')v.nativeSourceSha256=h('other');if(fault==='subject')v.subjectHash=h('other');expect(()=>approveOpenClawPreclaim(s.target,JSON.stringify(v),s.stop.signal)).toThrow();
});
it('honors cancellation both before claim and after fresh binding',()=>{const s=setup();bindOpenClawPreclaim(s.approval,s.bind());s.stop.abort();expect(()=>readOpenClawPreclaimSelection(s.approval)).toThrow();expect(()=>approveOpenClawPreclaim(s.target,s.raw,s.stop.signal)).toThrow();});
