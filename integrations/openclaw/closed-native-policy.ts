import type {ClosedNativeBinding} from './closed-native-owner';
function refuse():never{throw Error('ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED');}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// 2026.10.5 adds these API-key cache defaults even to an explicitly authored
// model map. They are metadata, not selection authority: modelPolicy below must
// still name ONLY the bound model, and all dispatch/harness route gates remain.
const CACHE_DEFAULT_REFS=Object.freeze(['anthropic/claude-sonnet-5-5','anthropic/claude-sonnet-5','anthropic/claude-sonnet-4-6']);
function nativeCacheMetadata(key:string,value:unknown){
 if(!CACHE_DEFAULT_REFS.includes(key)||!object(value)||!object(value.params)||Object.keys(value.params).length!==1||value.params.cacheRetention!=='short')return false;
 return Object.keys(value).every(k=>k==='params'||k==='alias'&&key===CACHE_DEFAULT_REFS[0]&&value.alias==='sonnet');
}
/** Inspect ACTUAL native effective config; never populate a loaded-state observation from it. */
export function assertRestrictedNativeConfiguration(actual:unknown,b:Readonly<ClosedNativeBinding>){
 if(!object(actual)||actual.plugins?.enabled!==false||actual.cloudWorkers||actual.hooks?.enabled||actual.cron?.enabled)refuse();
 const plugins=actual.plugins;if(plugins.load?.paths?.length||Object.values(plugins.entries??{}).some((v:any)=>v?.enabled!==false)
  ||Object.values(plugins.slots??{}).some(v=>v!=='none'))refuse();
 const providers=actual.models?.providers;if(actual.models?.mode!=='replace'||!object(providers)||Object.keys(providers).length!==1||!object(providers.anthropic))refuse();
 const p=providers.anthropic;if(p.api!=='anthropic-messages'||p.baseUrl!==b.proxyOrigin||p.request?.proxy||p.request?.tls||p.localService)refuse();
 const policy=(v:any)=>v===undefined||object(v)&&v.id==='openclaw'&&Object.keys(v).length===1;
 if(!policy(p.agentRuntime)||!Array.isArray(p.models)||p.models.length!==1||p.models[0]?.id!==b.modelId||!policy(p.models[0]?.agentRuntime))refuse();
 const ref='anthropic/'+b.modelId,defaults=actual.agents?.defaults,primary=typeof defaults?.model==='string'?defaults.model:defaults?.model?.primary;
 if(primary!==ref||defaults?.model?.fallbacks?.length||defaults?.imageModel||defaults?.cliBackends&&Object.keys(defaults.cliBackends).length)refuse();
 const selection=defaults?.modelPolicy;if(!object(selection)||Object.keys(selection).length!==1||!Array.isArray(selection.allow)||selection.allow.length!==1||selection.allow[0]!==ref)refuse();
 for(const [key,value]of Object.entries(defaults?.models??{}))if(key===ref?!object(value)||!policy(value.agentRuntime):!nativeCacheMetadata(key,value))refuse();
 const agents=actual.agents,entries=agents?.entries;
 if(!object(entries)||Object.keys(entries).length!==1||!Object.hasOwn(entries,b.nativeAgentId)||Object.hasOwn(agents,'list'))refuse();
 const a=entries[b.nativeAgentId];if(!object(a)||Object.hasOwn(a,'id')||Object.hasOwn(a,'default')||a.model||a.models||a.modelPolicy||a.agentRuntime||a.subagents||a.runtime||a.tools||a.hooks)refuse();
 // Client-supplied Responses functions remain the only permitted tool channel.
 if(actual.tools?.profile!=='minimal'||!Array.isArray(actual.tools?.deny)||!actual.tools.deny.includes('*'))refuse();
 if(actual.gateway?.reload?.mode!=='off')refuse();
}
export const CLOSED_NATIVE_FORBIDDEN_ENV=Object.freeze(['OPENCLAW_BUILD_PRIVATE_QA','OPENCLAW_QA_FORCE_RUNTIME','NODE_OPTIONS','ANTHROPIC_BASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','OPENCLAW_INCLUDE_ROOTS','OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS']);
export function assertRestrictedNativeEnvironment(env:Readonly<Record<string,string|undefined>>){if(CLOSED_NATIVE_FORBIDDEN_ENV.some(key=>env[key]!==undefined&&env[key]!==''))throw Error('ACTUAL_RESTRICTED_NATIVE_ENVIRONMENT_REQUIRED');}
