import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {inspectAcceptedCheckpointSessions,CHECKPOINT_SESSION_RETENTION_MS} from './accepted-checkpoint-retention';
const dirs:string[]=[],hash=(s:string)=>createHash('sha256').update(s).digest('hex');
afterEach(async()=>{for(const dir of dirs.splice(0)){if(path.dirname(dir)!==path.resolve(tmpdir())||!path.basename(dir).startsWith('envoi-checkpoint-retention-'))throw Error('CLEANUP_REFUSED');await fs.rm(dir,{recursive:true,force:true});}});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(tmpdir(),'envoi-checkpoint-retention-'));dirs.push(dir);
 const expires=Date.now()-CHECKPOINT_SESSION_RETENTION_MS-5000,checked=expires+1000;
 const current:any={workId:'msg_inert_checkpoint',caseId:'case_inert',agentId:'agent_inert',status:'retryable',attempts:4,failure:{reasonCode:'HANDLER_FAILED',retryable:true},retryAt:null,leaseExpiresAt:null,messageStatus:'acknowledged',processedAt:null,sessions:[]};
 const canonical:any={database:'sinaloa_staging',readOnly:'on',checkedAt:new Date(expires+CHECKPOINT_SESSION_RETENTION_MS).toISOString(),activeWorkLeases:0,activeCaseSessions:0};
 const archived:any={...canonical,checkedAt:new Date(checked).toISOString(),work:[{...current,sessions:undefined}],sessions:[{id:'case_session_inert',workId:current.workId,fence:4,status:'ended',createdAt:new Date(expires-900000).toISOString(),endedAt:new Date(expires-1000).toISOString(),expiresAt:new Date(expires).toISOString()}]};
 const file=path.join(dir,'verified-ended-sessions.json');
 const save=async()=>{const raw=JSON.stringify(archived);await fs.writeFile(file,raw);return{path:file,sha256:hash(raw)};};
 return{current,canonical,archived,file,save,pin:await save()};
}
it('uses verified archived rows at their original retention boundary without synthesizing current rows or changing any record',async()=>{
 const s=await fixture(),before=JSON.stringify(s.current),raw=await fs.readFile(s.file);
 expect(await inspectAcceptedCheckpointSessions(s.current,s.canonical,s.pin)).toMatchObject({basis:'verified_archived_ended_rows_after_retention',archivedSessionCount:1,currentRowsSynthesized:0});
 expect(JSON.stringify(s.current)).toBe(before);expect(s.current.sessions).toEqual([]);expect(await fs.readFile(s.file)).toEqual(raw);
});
it('retains the existing current-ended-row behavior without using an archive',async()=>{
 const s=await fixture();s.current.sessions=[{status:'ended'}];expect(await inspectAcceptedCheckpointSessions(s.current,s.canonical)).toEqual({basis:'current_ended_session_rows',currentRowsSynthesized:0});
});
it.each(['missing-proof','proof-drift','before-retention','current-before-archive','active-lease','active-session','current-live-session','unknown-session','wrong-attempt','changed-failure','wrong-work','processed','nonretryable','active-archive','missing-archive-session','wrong-session-work','live-archive-session','missing-expiry','future-end','invalid-fence','duplicate-session'] as const)('refuses unsafe retention evidence without mutation: %s',async fault=>{
 const s=await fixture();let pin:any=s.pin;
 if(fault==='before-retention')s.canonical.checkedAt=new Date(Date.parse(s.archived.sessions[0].expiresAt)+CHECKPOINT_SESSION_RETENTION_MS-1).toISOString();
 if(fault==='current-before-archive')s.canonical.checkedAt=new Date(Date.parse(s.archived.checkedAt)-1).toISOString();
 if(fault==='active-lease')s.canonical.activeWorkLeases=1;if(fault==='active-session')s.canonical.activeCaseSessions=1;
 if(fault==='current-live-session')s.current.sessions=[{status:'active'}];if(fault==='unknown-session')delete s.current.sessions;
 if(fault==='wrong-attempt')s.archived.work[0].attempts=3;if(fault==='changed-failure')s.archived.work[0].failure={...s.current.failure,createdAt:'changed'};
 if(fault==='wrong-work')s.archived.work[0].workId='msg_other';if(fault==='processed')s.current.processedAt=new Date().toISOString();if(fault==='nonretryable')s.current.failure={...s.current.failure,retryable:false};
 if(fault==='active-archive')s.archived.activeCaseSessions=1;if(fault==='missing-archive-session')s.archived.sessions=[];
 if(fault==='wrong-session-work')s.archived.sessions[0].workId='msg_other';if(fault==='live-archive-session')s.archived.sessions[0].status='active';
 if(fault==='missing-expiry')delete s.archived.sessions[0].expiresAt;if(fault==='future-end')s.archived.sessions[0].endedAt=new Date(Date.parse(s.archived.checkedAt)+1).toISOString();
 if(fault==='invalid-fence')s.archived.sessions[0].fence=0;if(fault==='duplicate-session')s.archived.sessions.push({...s.archived.sessions[0]});
 pin=await s.save();if(fault==='missing-proof')pin=undefined;if(fault==='proof-drift')await fs.appendFile(s.file,' ');
 const before=JSON.stringify(s.current),raw=await fs.readFile(s.file);await expect(inspectAcceptedCheckpointSessions(s.current,s.canonical,pin)).rejects.toThrow();expect(JSON.stringify(s.current)).toBe(before);expect(await fs.readFile(s.file)).toEqual(raw);
});
