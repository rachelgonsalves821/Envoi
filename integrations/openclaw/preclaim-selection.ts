import {createHash} from 'node:crypto';
import {openClawTargetDigest,type OpenClawWorkTarget} from './scoped-target';

type StableBinding=Pick<OpenClawWorkTarget['binding'],'window'|'workId'|'caseId'|'recipientAgentId'|'installationId'>;
export type OpenClawPreclaimTarget=Readonly<Omit<OpenClawWorkTarget,'binding'|'deadlineUnixMs'|'toolChannelSha256'|'ownerSelectionSha256'> & {
  binding:Readonly<StableBinding>;clientSource:string;nativeSourceSha256:string;inboxId:string;factoryPolicySha256:string;modelId:string;
}>;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function refuse():never{throw Error('EXACT_PERSONAL_PRECLAIM_REVIEW_REQUIRED');}
function loopback(value:string){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/')refuse();return u.origin;}
/** Explicit stable scope: session/fence/tool-token/deadline do not exist until a real claim. */
export function openClawPreclaimDigest(t:OpenClawPreclaimTarget){
  const b=t.binding;
  if(!b||!digest(b.window)||!/^msg_[\w-]+$/.test(b.workId)||!/^case_[\w-]+$/.test(b.caseId)||!/^agent_[\w-]+$/.test(b.recipientAgentId)||!/^installation_[\w-]+$/.test(b.installationId)
    ||!/^[a-f0-9]{40}$/.test(t.clientSource)||!digest(t.nativeSourceSha256)||!/^inbox_[\w-]+$/.test(t.inboxId)||!digest(t.factoryPolicySha256)||!/^[A-Za-z0-9][\w-]{0,255}$/.test(t.modelId)||![t.configurationSha256,t.stateDirectorySha256,t.configurationPathSha256,t.workspaceSha256,t.agentStateSha256].every(digest)
    ||![t.agentId,t.processIdentity,t.proxyIdentity].every(v=>typeof v==='string'&&/^[A-Za-z0-9][\w-]{0,255}$/.test(v))||typeof t.gatewayToken!=='string'||!t.gatewayToken||t.gatewayToken.length>16384||/[\x00-\x20\x7f]/.test(t.gatewayToken))refuse();
  const gateway=loopback(t.gatewayUrl),proxy=loopback(t.proxyOrigin);if(gateway===proxy)refuse();
  return hash(JSON.stringify({binding:{window:b.window,workId:b.workId,caseId:b.caseId,recipientAgentId:b.recipientAgentId,installationId:b.installationId},
    clientSource:t.clientSource,nativeSourceSha256:t.nativeSourceSha256,inboxId:t.inboxId,factoryPolicySha256:t.factoryPolicySha256,modelId:t.modelId,gatewayOrigin:gateway,gatewayTokenSha256:hash(t.gatewayToken),agentId:t.agentId,processIdentity:t.processIdentity,
    configurationSha256:t.configurationSha256,stateDirectorySha256:t.stateDirectorySha256,configurationPathSha256:t.configurationPathSha256,workspaceSha256:t.workspaceSha256,agentStateSha256:t.agentStateSha256,proxyOrigin:proxy,proxyIdentity:t.proxyIdentity}));
}
declare const approvalBrand:unique symbol;
export type ApprovedOpenClawPreclaim=Readonly<{[approvalBrand]:true}>;
type Approval={target:OpenClawPreclaimTarget;digest:string;receiptSha256:string;bound?:Readonly<OpenClawWorkTarget>;cancel:AbortSignal};
const approvals=new WeakMap<ApprovedOpenClawPreclaim,Approval>();
/** The trusted host reads an actual human answer. This function never asks, claims or starts a host. */
export function approveOpenClawPreclaim(target:OpenClawPreclaimTarget,raw:string,cancel:AbortSignal):ApprovedOpenClawPreclaim{
  cancel.throwIfAborted();if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)refuse();const d=openClawPreclaimDigest(target),v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))refuse();
  const exact={purpose:'phase-c-personal-preclaim-native-selection',version:1,ownerApproved:true,lifetime:'one-claim-until-cancel',subjectHash:d,
    window:target.binding.window,clientSource:target.clientSource,nativeSourceSha256:target.nativeSourceSha256};
  if(Object.keys(v).sort().join()!==[...Object.keys(exact),'approvedAtUtc'].sort().join()||Object.entries(exact).some(([k,x])=>v[k]!==x)||!Number.isFinite(Date.parse(v.approvedAtUtc))||Date.parse(v.approvedAtUtc)>Date.now())refuse();
  const approval=Object.freeze({})as ApprovedOpenClawPreclaim;
  approvals.set(approval,{target:Object.freeze({...target,binding:Object.freeze({...target.binding})}),digest:d,receiptSha256:hash(raw),cancel});return approval;
}
/** Used immediately before the queue claim. Waiting for the personal answer has no timer. */
export function assertOpenClawPreclaim(approval:ApprovedOpenClawPreclaim,expected:StableBinding&{clientSource:string;nativeSourceSha256?:string;inboxId?:string;factoryPolicySha256?:string}){
  const a=approvals.get(approval);if(!a||a.bound)refuse();a.cancel.throwIfAborted();
  if(Object.entries(expected).some(([k,v])=>(['clientSource','nativeSourceSha256','inboxId','factoryPolicySha256'].includes(k)?a.target[k as keyof OpenClawPreclaimTarget]:a.target.binding[k as keyof StableBinding])!==v))refuse();
}
/** Called only with the fresh canonical claim/session. The full native target remains exact and bounded. */
export function bindOpenClawPreclaim(approval:ApprovedOpenClawPreclaim,target:OpenClawWorkTarget){
  const a=approvals.get(approval);if(!a||a.bound)refuse();a.cancel.throwIfAborted();
  if(openClawPreclaimDigest({...target,clientSource:a.target.clientSource,nativeSourceSha256:a.target.nativeSourceSha256,inboxId:a.target.inboxId,factoryPolicySha256:a.target.factoryPolicySha256,modelId:a.target.modelId})!==a.digest
    ||!/^case_session_[\w-]+$/.test(target.binding.caseSessionId)||!Number.isSafeInteger(target.binding.fence)||target.binding.fence<1||!digest(target.toolChannelSha256)
    ||target.ownerSelectionSha256!==a.receiptSha256||!Number.isSafeInteger(target.deadlineUnixMs)||target.deadlineUnixMs<=Date.now()||target.deadlineUnixMs>Date.now()+120000)refuse();
  a.bound=Object.freeze({...target,binding:Object.freeze({...target.binding})});return readOpenClawPreclaimSelection(approval);
}
export function openClawPreclaimReceiptSha256(approval:ApprovedOpenClawPreclaim){const a=approvals.get(approval);if(!a)refuse();a.cancel.throwIfAborted();return a.receiptSha256;}
export function readOpenClawPreclaimSelection(approval:ApprovedOpenClawPreclaim){
  const a=approvals.get(approval);if(!a?.bound)refuse();a.cancel.throwIfAborted();const t=a.bound;if(Date.now()>=t.deadlineUnixMs)refuse();
  return Object.freeze({receiptSha256:a.receiptSha256,clientSource:a.target.clientSource,nativeSourceSha256:a.target.nativeSourceSha256,window:t.binding.window,role:'openclaw' as const,workId:t.binding.workId,caseSessionId:t.binding.caseSessionId,toolChannelSha256:t.toolChannelSha256,targetSha256:openClawTargetDigest(t)});
}
/** Derived admission binding, not a second human receipt or a runtime observation.
 * The owned child must still prove its actual closed core/registry/transport and
 * every physical request must pass the existing charged request gate. */
export function deriveOpenClawPreclaimCapability(approval:ApprovedOpenClawPreclaim){
  const selection=readOpenClawPreclaimSelection(approval),a=approvals.get(approval)!;
  const subject=Object.freeze({purpose:'phase-c-preclaim-bound-native-capability' as const,version:1 as const,
    preclaimReceiptSha256:a.receiptSha256,preclaimSubjectSha256:a.digest,targetSha256:selection.targetSha256,
    window:selection.window,clientSource:selection.clientSource,nativeSourceSha256:selection.nativeSourceSha256,
    factoryPolicySha256:a.target.factoryPolicySha256,modelId:a.target.modelId,caseSessionId:selection.caseSessionId,toolChannelSha256:selection.toolChannelSha256,
    deadlineUnixMs:a.bound!.deadlineUnixMs,policy:'closed-core-anthropic-no-plugins-no-fallback-no-external-tools' as const});
  return Object.freeze({...subject,capabilitySha256:hash(JSON.stringify(subject))});
}
