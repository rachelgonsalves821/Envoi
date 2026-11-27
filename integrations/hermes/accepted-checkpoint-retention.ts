// A read-only disposition, never a replacement for current canonical authority.
import {readUnforwardedPin} from './controlled-unforwarded';
import type {ProgressPin} from './stopped-progress';
export const CHECKPOINT_SESSION_RETENTION_MS=24*60*60_000;
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const equal=(a:any,b:any)=>JSON.stringify(canon(a??null))===JSON.stringify(canon(b??null));
const time=(v:any)=>typeof v==='string'?Date.parse(v):NaN;
function refuse():never{throw Object.assign(Error('VERIFIED_CHECKPOINT_SESSION_RETENTION_REQUIRED'),{code:'VERIFIED_CHECKPOINT_SESSION_RETENTION_REQUIRED'});}
/** The caller supplies this proof only after complete accepted-history inspection.
 * Current rows stay empty. The original session expiry and attempt stay intact. */
export async function inspectAcceptedCheckpointSessions(current:any,canonical:any,verifiedEndedSessions?:ProgressPin){
 if(!Array.isArray(current?.sessions)||current.sessions.some((s:any)=>s.status!=='ended'))refuse();
 if(current.sessions.length)return{basis:'current_ended_session_rows' as const,currentRowsSynthesized:0};
 if(!verifiedEndedSessions||canonical.database!=='sinaloa_staging'||canonical.readOnly!=='on'||canonical.activeWorkLeases!==0||canonical.activeCaseSessions!==0||current.leaseExpiresAt!=null
  ||current.status!=='retryable'||current.messageStatus!=='acknowledged'||current.processedAt!=null||current.failure?.retryable!==true||current.failure.reasonCode!=='HANDLER_FAILED'
  ||!Number.isSafeInteger(current.attempts)||current.attempts<1||typeof current.workId!=='string'||!current.workId)refuse();
 const archived=(await readUnforwardedPin(verifiedEndedSessions)).value;
 const observed=time(archived.checkedAt),checked=time(canonical.checkedAt),works=archived.work?.filter((w:any)=>w.workId===current.workId);
 if(archived.database!=='sinaloa_staging'||archived.readOnly!=='on'||archived.activeWorkLeases!==0||archived.activeCaseSessions!==0
  ||!Number.isFinite(observed)||!Number.isFinite(checked)||checked<observed||checked>Date.now()||works?.length!==1
  ||['workId','status','attempts','failure','retryAt','leaseExpiresAt','messageStatus','processedAt'].some(k=>!equal(current[k],works[0][k])))refuse();
 const sessions=archived.sessions;
 if(!Array.isArray(sessions)||sessions.some((s:any)=>s.status!=='ended'))refuse();
 const prior=sessions.filter((s:any)=>s.workId===current.workId);
 if(!prior.length||new Set(prior.map((s:any)=>s.id)).size!==prior.length)refuse();
 for(const session of prior){
  const created=time(session.createdAt),ended=time(session.endedAt),expires=time(session.expiresAt);
  if(typeof session.id!=='string'||!session.id||!Number.isSafeInteger(session.fence)||session.fence<1
   ||![created,ended,expires].every(Number.isFinite)||ended<created||expires<=created||ended>observed
   ||checked<expires+CHECKPOINT_SESSION_RETENTION_MS)refuse();
 }
 return{basis:'verified_archived_ended_rows_after_retention' as const,archiveSha256:verifiedEndedSessions.sha256,
  historicalCheckedAt:archived.checkedAt,retentionMs:CHECKPOINT_SESSION_RETENTION_MS,archivedSessionCount:prior.length,currentRowsSynthesized:0};
}
