import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {matchesRecordedWorkflowParent} from './accepted-checkpoint-workflow-bootstrap';
const source='b853393dc148b0919f085223b95fe3361236cd36';
const pin=(name:string,n:string)=>({path:path.resolve('INERT',name),sha256:n.repeat(64)});
const ancestor=pin('last-startup.json','1'),immediate=pin('latest-timeout.json','2'),core=pin('workflow-session.mjs','3');
const oldWriter=Buffer.from('const execution={priorExecution:p.controlledRecoveryBase.startupStops.at(-1).execution};');
const fixture=()=>({clientSource:source,recordedParent:ancestor,priorExecution:immediate,declaredStartupStops:[{execution:ancestor}],inspectedStartupStops:[{execution:ancestor}],core});
it('keeps the immediate-parent rule for current writers without reading a legacy module',async()=>{
 const read=vi.fn(async()=>{throw Error('MUST_NOT_READ');});
 expect(await matchesRecordedWorkflowParent({...fixture(),clientSource:'f'.repeat(40),recordedParent:immediate},read)).toBe(true);expect(read).not.toHaveBeenCalled();
});
it('retains the old writer description only when its last declared startup is already inspected and pinned',async()=>{
 const read=vi.fn(async p=>{expect(p).toEqual(core);return oldWriter;});
 expect(await matchesRecordedWorkflowParent(fixture(),read)).toBe(true);expect(read).toHaveBeenCalledOnce();
});
const invalid=[
 ['another writer',(x:any)=>{x.clientSource='f'.repeat(40);}],
 ['unrelated recorded parent',(x:any)=>{x.recordedParent=pin('unrelated.json','4');}],
 ['same hash at another path',(x:any)=>{x.recordedParent=pin('foreign.json','1');}],
 ['uninspected declared ancestor',(x:any)=>{x.declaredStartupStops=[{execution:pin('uninspected.json','4')}];}],
 ['missing declared startup',(x:any)=>{x.declaredStartupStops=[];}],
 ['missing inspected startup',(x:any)=>{x.inspectedStartupStops=[];}],
 ['older startup instead of last',(x:any)=>{x.declaredStartupStops.push({execution:pin('newer.json','4')});x.inspectedStartupStops.push({execution:pin('newer.json','4')});}],
 ['missing writer pin',(x:any)=>{delete x.core;}],
 ['another private module',(x:any)=>{x.core=pin('unrelated.mjs','3');}],
] as const;
it.each(invalid)('refuses %s before any legacy source read',async(_name,mutate)=>{
 const input=fixture(),read=vi.fn(async()=>oldWriter);mutate(input);expect(await matchesRecordedWorkflowParent(input,read)).toBe(false);expect(read).not.toHaveBeenCalled();
});
it('rejects a writer that does not declare the legacy parent selection',async()=>{
 expect(await matchesRecordedWorkflowParent(fixture(),async()=>Buffer.from('const execution={priorExecution:immediate};'))).toBe(false);
});
it('propagates a changed or unreadable writer pin rather than accepting its declared path',async()=>{
 await expect(matchesRecordedWorkflowParent(fixture(),async()=>{throw Error('PIN_CHANGED');})).rejects.toThrow('PIN_CHANGED');
});