import Ajv from 'ajv';
import { createWakeDestination, wakeError } from './http-wake-destination.js';

const object = (properties, required=[]) => ({type:'object',additionalProperties:false,...(required.length?{required}:{}),properties});
const subscriptionId={type:'string',pattern:'^wake_sub_[A-Za-z0-9_-]+$'};
export const mcpWakeTools = Object.freeze([
  {name:'envoi_wake_create',description:'Create a signed wake subscription to this connector’s declared backend origin.',permission:'receive_agent_messages',inputSchema:object({url:{type:'string',maxLength:8192}},['url'])},
  {name:'envoi_wake_activate',description:'Activate a wake subscription using the challenge delivered to its backend.',permission:'receive_agent_messages',inputSchema:object({subscriptionId,challenge:{type:'string',pattern:'^envoi_wake_challenge_[A-Za-z0-9_-]+$'}},['subscriptionId','challenge'])},
  {name:'envoi_wake_end',description:'End this installation’s wake subscription.',permission:'receive_agent_messages',inputSchema:object({subscriptionId},['subscriptionId'])},
  {name:'envoi_wake_status',description:'Read this installation’s current wake availability and ending reason.',permission:'receive_agent_messages',inputSchema:object({})}
].map(tool=>({...tool,scope:'envoi.agent',restEquivalent:{envoi_wake_create:'POST /api/agent/wake-subscriptions',envoi_wake_activate:'POST /api/agent/wake-subscriptions/{id}/activate',envoi_wake_end:'POST /api/agent/wake-subscriptions/{id}/end',envoi_wake_status:'GET /api/agent/status (httpWake)'}[tool.name]})));
const errors = {
  WAKE_SUBSCRIPTION_INVALID:'The wake request is not valid.',WAKE_URL_REJECTED:'The wake URL is not allowed.',
  WAKE_SUBSCRIPTION_NOT_FOUND:'No such wake subscription.',WAKE_CHALLENGE_INVALID:'The wake challenge does not match.',
  WAKE_SUBSCRIPTION_ENDED:'The wake subscription has ended.',WAKE_ROUTE_NOT_SUPPORTED:'This connection has no wake path.'
};
const ajv=new Ajv({strict:true});
const validators=new Map(mcpWakeTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}],isError:value.ok===false});
export function createMcpWakeTools({httpWake,enabled=false,clientFor=()=>null}={}) {
  const destination=createWakeDestination({env:{}});
  const available=identity=>Boolean(enabled&&!identity.mcpScope&&identity.agent?.permissions?.includes('receive_agent_messages'));
  const binding=identity=>({inboxId:identity.inboxId,agentId:identity.agent.id,familyId:identity.family?.id||identity.familyId,installationId:identity.installationId||identity.family?.installationId});
  return {tools:mcpWakeTools,available,
    async call(name,args,identity){
      if(!available(identity)||!validators.has(name))throw Object.assign(new Error('Unknown tool'),{rpcCode:-32602});
      try{
        if(!validators.get(name)(args))throw wakeError(400,'WAKE_SUBSCRIPTION_INVALID');
        const client=await clientFor(identity);
        const origins=client?.wakeOrigins;
        const bound=binding(identity);
        if(!identity.family?.audience||(client?.connectionRoute||client?.route)!=='provider_connector'||!Array.isArray(origins)||!origins.length||!bound.installationId)throw wakeError(400,'WAKE_ROUTE_NOT_SUPPORTED');
        let result;
        if(name==='envoi_wake_create'){
          const url=destination.canonical(args.url);
          if(!origins.includes(new URL(url).origin))throw wakeError(400,'WAKE_URL_REJECTED','origin_not_declared');
          result=await httpWake.create(bound,{url},{createdVia:'mcp'});
        }else if(name==='envoi_wake_activate')result=await httpWake.activate(bound,args.subscriptionId,{challenge:args.challenge});
        else if(name==='envoi_wake_end')result=await httpWake.end(bound,args.subscriptionId);
        else result={httpWake:await httpWake.status(bound)};
        return envelope({ok:true,tool:name,result});
      }catch(error){
        if(!errors[error.code])throw error;
        return envelope({ok:false,tool:name,code:error.code,...(error.reason?{reason:error.reason}:{}),message:errors[error.code],retryable:false});
      }
    }
  };
}
