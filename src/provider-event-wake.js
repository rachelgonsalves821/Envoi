import crypto from 'node:crypto';
import net from 'node:net';
import { createWakeDestination, wakeError } from './http-wake-destination.js';

export const providerEventsProtocolVersion='2026-07-28';
export const providerEvents = Object.freeze([
  {name:'envoi.work_available',description:'Work for this connection became claimable. Opaque hint: claim to learn what.',delivery:['webhook'],inputSchema:{type:'object',additionalProperties:false,properties:{}},payloadSchema:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{enum:['message_delivered','human_instruction','agent_resumed','case_resumed','counterparty_resumed','work_due','subscription_activated']}}}},
  {name:'envoi.control_changed',description:'This connection’s pause state or a case control changed. Opaque hint.',delivery:['webhook'],inputSchema:{type:'object',additionalProperties:false,properties:{}},payloadSchema:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{enum:['agent_paused','case_controlled']}}}}
]);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const one=Buffer.from(String(a??'')),two=Buffer.from(String(b??''));return one.length===two.length&&crypto.timingSafeEqual(one,two);};
const rpc=(code,message,reason)=>Object.assign(new Error(message),{rpcCode:code,...(reason?{reason}:{})});
const invalid=()=>rpc(-32602,'Invalid params');
const callbackError=reason=>rpc(-32015,'CallbackEndpointError',reason);
const closed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const empty=value=>closed(value,[])&&Object.keys(value).length===0;
function secretBytes(secret){
  if(typeof secret!=='string'||secret.length>94||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw invalid();
  const text=secret.slice(6),bytes=Buffer.from(text,'base64');
  if(bytes.length<24||bytes.length>64||bytes.toString('base64').replace(/=+$/,'')!==text.replace(/=+$/,''))throw invalid();
  return bytes;
}
export function signProviderWebhook({secret,previousSecret,bodyText,id,at,subscriptionId}){
  const timestamp=String(Math.floor(Date.parse(at)/1000));
  const signatures=[secret,...(previousSecret?[previousSecret]:[])].map(value=>`v1,${crypto.createHmac('sha256',secretBytes(value)).update(`${id}.${timestamp}.${bodyText}`).digest('base64')}`);
  return {'content-type':'application/json','user-agent':'Envoi-Wake/1','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':signatures.join(' '),...(subscriptionId?{'x-mcp-subscription-id':subscriptionId}:{})};
}
function originSet(value){
  const values=Array.isArray(value)?value:String(value||'').split(',').map(value=>value.trim()).filter(Boolean);
  return new Set(values.map(value=>{let url;try{url=new URL(value);}catch{throw new Error('Invalid provider wake origin');}if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||net.isIP(url.hostname.replace(/^\[|\]$/g,''))||url.origin!==value)throw new Error('Invalid provider wake origin');return url.origin;}));
}
export function createProviderEventWake({httpWake,store,mcpEventsEnabled=false,grokTriggerEnabled=false,key,env=process.env,now=()=>new Date().toISOString(),audit=async()=>{},resolveDestination,eventHistory=async()=>({cursor:null,truncated:false,events:[]})}={}){
  const dataKey=key||((mcpEventsEnabled||grokTriggerEnabled)&&env.ENVOI_DATA_ENCRYPTION_KEY?crypto.createHash('sha256').update(env.ENVOI_DATA_ENCRYPTION_KEY).digest():null);
  if((mcpEventsEnabled||grokTriggerEnabled)&&(!Buffer.isBuffer(dataKey)||dataKey.length!==32))throw new Error('Provider wake requires the server data encryption key');
  const destination=createWakeDestination({env});const resolve=resolveDestination||destination.resolve;
  const callbacks=originSet(env.ENVOI_MCP_EVENTS_CALLBACK_ORIGINS),triggers=originSet(env.ENVOI_GROK_TRIGGER_ORIGINS);
  const allowlistDigest=hash([...callbacks].sort().join('\n'));
  const time=()=>Date.parse(now());
  const encode=(secret,id)=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',dataKey,iv);cipher.setAAD(Buffer.from(id));const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};};
  const decode=(encrypted,id)=>{const decipher=crypto.createDecipheriv('aes-256-gcm',dataKey,Buffer.from(encrypted.iv,'base64'));decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]).toString('utf8');};
  const bound=identity=>({inboxId:identity.inboxId,agentId:identity.agent?.id||identity.agentId,familyId:identity.family?.id||identity.familyId,installationId:identity.installationId||identity.family?.installationId});
  const available=(identity,version)=>Boolean(mcpEventsEnabled&&version===providerEventsProtocolVersion&&identity.family?.audience&&!identity.mcpScope&&(identity.connectionRoute===undefined||['remote_mcp_oauth','provider_connector'].includes(identity.connectionRoute))&&identity.agent?.permissions?.includes('receive_agent_messages')&&bound(identity).installationId);
  const requireEvents=(identity,version)=>{if(!available(identity,version))throw rpc(-32601,'Method not found');};
  const cachePath=(identity,url)=>`http-wake/verification/${hash(`${identity.installationId}\n${url}`)}.json`;
  const checked=(url,allowlist)=>{const canonical=destination.canonical(url);if(!allowlist.has(new URL(canonical).origin))throw wakeError(400,'WAKE_URL_REJECTED','origin_not_allowed');return canonical;};
  const signature=(sub,event)=>signProviderWebhook({secret:decode(sub.secretEncrypted,sub.id),previousSecret:sub.previousSecretEncrypted&&Date.parse(sub.previousSecretUntil)>time()?decode(sub.previousSecretEncrypted,sub.id):null,bodyText:event.bodyText,id:event.id,at:new Date(Math.max(time(),Date.parse(event.createdAt))).toISOString(),subscriptionId:sub.profile==='mcp_events'?sub.id:undefined});
  const ended=async sub=>{if(sub.profile==='mcp_events')await store.deleteJson(cachePath(sub,sub.url));};
  httpWake.registerProfile('mcp_events',{
    destination:url=>checked(url,callbacks),headers:signature,ended,
    accepts:(sub,event)=>sub.eventName===event.type.replace(/^wake\./,'envoi.')&&providerEvents.find(row=>row.name===sub.eventName).payloadSchema.properties.reason.enum.includes(event.reason),
    body:(sub,event)=>({eventId:event.id,name:event.type.replace(/^wake\./,'envoi.'),timestamp:event.createdAt,data:{reason:event.reason},cursor:sub.cursor||null})
  });
  httpWake.registerProfile('grok_trigger',{destination:url=>checked(url,triggers),headers:signature});
  function paramsValid(params,subscribe){
    if(!closed(params,subscribe?['name','arguments','delivery','cursor','ttlMs']:['name','arguments','delivery'])||!providerEvents.some(event=>event.name===params.name)||!empty(params.arguments)||!closed(params.delivery,subscribe?['mode','url','secret']:['mode','url'])||params.delivery.mode!=='webhook'||typeof params.delivery.url!=='string'||params.delivery.url.length>2048)throw invalid();
    if(subscribe&&params.cursor!==undefined&&params.cursor!==null&&(typeof params.cursor!=='string'||!/^[0-9]{20}$/.test(params.cursor)))throw invalid();
    if(subscribe&&params.ttlMs!==undefined&&params.ttlMs!==null&&(!Number.isSafeInteger(params.ttlMs)||params.ttlMs<3600000||params.ttlMs>604800000))throw invalid();
    if(subscribe)secretBytes(params.delivery.secret);
  }
  const identityId=(identity,name,url)=>`evtsub_${hash(JSON.stringify([identity.installationId,name,{},url])).slice(0,20)}`;
  const grokPublic=sub=>({id:sub.id,kind:'grok_webhook_trigger',installationId:sub.installationId,agentId:sub.agentId,url:sub.url,secretSet:Boolean(sub.secretEncrypted),state:sub.status==='ended'?'ended':sub.targetState||'active',stateReason:sub.status==='ended'?sub.endedReason:sub.stateReason||null,createdAt:sub.createdAt,updatedAt:sub.updatedAt||sub.createdAt,lastAttemptAt:sub.delivery.lastAttemptAt,lastAcceptedAt:sub.delivery.lastSuccessAt,consecutiveFailures:sub.delivery.consecutiveFailures});
  const grokAvailable=()=>{if(!grokTriggerEnabled)throw wakeError(404,'FEATURE_DISABLED');};
  return {available,events:providerEvents,
    discover(identity,version){return available(identity,version)?{events:{}}:{};},
    list(identity,params={},version){requireEvents(identity,version);if(!empty(params))throw invalid();return {events:providerEvents};},
    async subscribe(identity,params,version){
      requireEvents(identity,version);paramsValid(params,true);const binding=bound(identity);let url;
      try{url=checked(params.delivery.url,callbacks);}catch(error){throw callbackError(error.reason==='origin_not_allowed'?'origin_not_allowed':'address_not_allowed');}
      await httpWake.reserveProfileCreate(binding,'mcp_events',identityId(binding,params.name,url));
      const cache=cachePath(binding,url),oneWayKey=hash(`${params.delivery.secret}\n${allowlistDigest}`);
      const existing=(await httpWake.profileRecords(binding,'mcp_events')).find(sub=>sub.id===identityId(binding,params.name,url));
      let resolution;try{resolution=await resolve(url);}catch{await store.deleteJson(cache);throw callbackError('address_not_allowed');}
      if(!resolution?.addresses?.length||resolution.addresses.some(address=>!destination.allowed(address))){await store.deleteJson(cache);throw callbackError('address_not_allowed');}
      const cached=await store.getJson(cache);
      let verified=false;
      if(existing?.status==='ended'||!cached||cached.key!==oneWayKey||Date.parse(cached.expiresAt)<=time()){
        await store.deleteJson(cache);
        const challenge=`envoi_wake_challenge_${crypto.randomBytes(32).toString('base64url')}`,bodyText=JSON.stringify({type:'verification',challenge}),id=`wake_evt_${crypto.randomBytes(18).toString('base64url')}`;
        const response=await httpWake.verifyCallback(binding,url,{bodyText,headers:signProviderWebhook({secret:params.delivery.secret,bodyText,id,at:now(),subscriptionId:identityId(binding,params.name,url)})});
        let echoed=response.body?.challenge;try{echoed||=JSON.parse(response.bodyText).challenge;}catch{/* Bounded malformed response is a verification refusal. */}
        if(response.failureClass==='timeout')throw callbackError('timeout');
        if(!(response.status>=200&&response.status<300)||response.bodyTooLarge||!equal(echoed,challenge))throw callbackError('challenge_failed');
        verified=true;
      }
      const history=await eventHistory(binding,params.cursor??null);const id=identityId(binding,params.name,url);
      const priorChanged=existing?.status==='active'&&existing.secretEncrypted&&!equal(existing.secretHash,hash(params.delivery.secret));
      const sub=await httpWake.createProfile(binding,'mcp_events',{id,url,quotaReserved:true,expiresAt:new Date(time()+(params.ttlMs??604800000)).toISOString(),eventName:params.name,cursor:history.cursor||null,secretHash:hash(params.delivery.secret),secretEncrypted:encode(params.delivery.secret,id),previousSecretEncrypted:priorChanged?existing.secretEncrypted:existing?.previousSecretEncrypted,previousSecretUntil:priorChanged?new Date(time()+600000).toISOString():existing?.previousSecretUntil});
      if(verified)await store.putJson(cache,{key:oneWayKey,expiresAt:new Date(time()+3600000).toISOString()});
      for(const event of history.events||[])await httpWake.queueProfile(sub,event.type,event.reason,event.cursor);
      return {id,refreshBefore:sub.expiresAt,cursor:history.cursor||null,truncated:Boolean(history.truncated)};
    },
    async unsubscribe(identity,params,version){requireEvents(identity,version);paramsValid(params,false);const binding=bound(identity);let url;try{url=destination.canonical(params.delivery.url);}catch{throw invalid();}const id=identityId(binding,params.name,url);const sub=(await httpWake.profileRecords(binding,'mcp_events')).find(sub=>sub.id===id);if(sub)await httpWake.endProfile(binding,id);await store.deleteJson(cachePath(binding,url));return {};},
    async putGrok(identity,params){
      grokAvailable();const binding=bound(identity);if(!binding.installationId||!binding.familyId)throw wakeError(400,'WAKE_TARGET_INVALID','installation_required');
      if(!closed(params,['url','secret'])||typeof params.url!=='string')throw wakeError(400,'WAKE_TARGET_INVALID','secret_invalid');
      try{secretBytes(params.secret);}catch{throw wakeError(400,'WAKE_TARGET_INVALID','secret_invalid');}
      const url=checked(params.url,triggers);
      const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');
      const current=records.find(sub=>sub.status!=='ended');
      const id=current?.installationId===binding.installationId?current.id:`wake_target_${crypto.randomBytes(18).toString('base64url')}`;
      await httpWake.reserveProfileCreate(binding,'grok_trigger',id);await resolve(url);
      for(const sub of records)if(sub.installationId!==binding.installationId&&sub.status!=='ended')await httpWake.endProfile({inboxId:binding.inboxId,agentId:binding.agentId},sub.id,'replaced');
      const sub=await httpWake.createProfile(binding,'grok_trigger',{id,url,allowPaused:true,quotaReserved:true,secretEncrypted:encode(params.secret,id),previousSecretEncrypted:undefined,previousSecretUntil:undefined,targetState:'active',stateReason:null,updatedAt:now()});
      await audit(binding.inboxId,'agent.wake_target_secret_set',{agentId:binding.agentId,installationId:binding.installationId,secretSet:true},now());
      await httpWake.queueProfile(sub,'wake.work_available','work_due');return {target:grokPublic(sub)};
    },
    async getGrok(identity){const binding=bound(identity);const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');grokAvailable();const sub=records.find(sub=>sub.status!=='ended')||records[0];return {target:sub?grokPublic(sub):null};},
    async deleteGrok(identity){const binding=bound(identity);const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');grokAvailable();for(const sub of records)await httpWake.endProfile({inboxId:binding.inboxId,agentId:binding.agentId},sub.id,'ended_by_owner');return {};}
  };
}
