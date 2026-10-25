import test from 'node:test';
import assert from 'node:assert/strict';
import {readOnboardingFlags,onboardingFlagErrors,routeAvailability} from '../src/onboarding-flags.js';
import {parsePreRegisteredClients} from '../src/agent-remote-auth.js';

const profiles={ENVOI_MCP_WAKE_V1:'mcpWake',ENVOI_MCP_EVENTS_V1:'mcpEvents',ENVOI_GROK_TRIGGER_V1:'grokTrigger',ENVOI_PROVIDER_GATEWAY_NATIVE_V1:'providerGatewayNative'};
const prerequisites={
  ENVOI_MCP_WAKE_V1:['ENVOI_HTTP_WAKE_V1','ENVOI_INSTALLATIONS_V2','ENVOI_AGENT_REGISTRATION_V2','ENVOI_PROVIDER_CONNECTORS'],
  ENVOI_MCP_EVENTS_V1:['ENVOI_HTTP_WAKE_V1','ENVOI_INSTALLATIONS_V2','ENVOI_AGENT_REGISTRATION_V2'],
  ENVOI_GROK_TRIGGER_V1:['ENVOI_HTTP_WAKE_V1','ENVOI_INSTALLATIONS_V2','ENVOI_AGENT_REGISTRATION_V2'],
  ENVOI_PROVIDER_GATEWAY_NATIVE_V1:['ENVOI_PROVIDER_BROWSER_POLL','ENVOI_CASE_SESSIONS_V1','ENVOI_INSTALLATIONS_V2','ENVOI_AGENT_REGISTRATION_V2']
};
const base={ENVOI_PUBLIC_URL:'https://envoi-config.example.com',ENVOI_HTTP_WAKE_V1:'true',ENVOI_INSTALLATIONS_V2:'true',ENVOI_AGENT_REGISTRATION_V2:'true',ENVOI_PROVIDER_CONNECTORS:'true',ENVOI_REMOTE_MCP_OAUTH:'true',ENVOI_AUTHENTICATED_REST_ROUTE:'true',ENVOI_PROVIDER_BROWSER_POLL:'true',ENVOI_CASE_SESSIONS_V1:'true'};
const client=overrides=>({clientId:'client_provider-config',clientName:'Configuration test backend',connectionRoute:'provider_connector',redirectUris:['https://provider-config.example.com/callback'],tokenEndpointAuthMethod:'none',bootstrapCode:false,provider:'config-test',...overrides});
const parse=value=>parsePreRegisteredClients(JSON.stringify([value])).get(value.clientId);

test('all four provider extensions default OFF and do not require their dependencies while OFF',()=>{
  const defaultFlags=readOnboardingFlags({});assert.deepEqual(defaultFlags,{installations:false,registration:false,authenticatedRest:false,caseSessions:false,httpWake:false});
  for(const [name,property]of Object.entries(profiles)){
    for(const value of [undefined,'','false']){
      const flags=readOnboardingFlags(value===undefined?{}:{[name]:value});assert.equal(Boolean(flags[property]),false,name);assert.deepEqual(flags,defaultFlags);
    }
  }
  assert.deepEqual(onboardingFlagErrors(Object.fromEntries(Object.keys(profiles).map(name=>[name,'false']))),[]);
});
test('only exact lowercase string true enables each extension; mistyped values fail startup closed',()=>{
  for(const [name,property]of Object.entries(profiles)){
    assert.equal(readOnboardingFlags({...base,[name]:'true'})[property],true,name);
    for(const value of [true,false,1,0,'1','TRUE','True',' true','true ','FALSE','yes',null,[],{}]){
      assert.throws(()=>readOnboardingFlags({...base,[name]:value}),new RegExp(`${name} must be true or false`));
    }
  }
});
test('each extension refuses every missing required dependency instead of accepting a partially enabled configuration',()=>{
  for(const [name,required]of Object.entries(prerequisites)){
    for(const dependency of required){
      const env={...base,[name]:'true',[dependency]:'false'};
      assert.ok(onboardingFlagErrors(env).includes(`${name} requires ${dependency}`),`${name} accepted missing ${dependency}`);assert.throws(()=>readOnboardingFlags(env),/Invalid onboarding flags/);
    }
  }
  // Native work uses its approved gateway/session prerequisites; enabling an unrelated wake
  // mechanism is not a substitute for them and is not an extra prerequisite of its own.
  assert.equal(readOnboardingFlags({...base,ENVOI_HTTP_WAKE_V1:'false',ENVOI_PROVIDER_GATEWAY_NATIVE_V1:'true'}).providerGatewayNative,true);
});
test('MCP events accepts either approved OAuth route, while MCP wake requires the connector route',()=>{
  for(const enabledRoute of ['ENVOI_REMOTE_MCP_OAUTH','ENVOI_PROVIDER_CONNECTORS']){
    const flags=readOnboardingFlags({...base,ENVOI_MCP_EVENTS_V1:'true',ENVOI_REMOTE_MCP_OAUTH:'false',ENVOI_PROVIDER_CONNECTORS:'false',[enabledRoute]:'true'});assert.equal(flags.mcpEvents,true);
  }
  const neither={...base,ENVOI_MCP_EVENTS_V1:'true',ENVOI_REMOTE_MCP_OAUTH:'false',ENVOI_PROVIDER_CONNECTORS:'false'};assert.throws(()=>readOnboardingFlags(neither),/ENVOI_MCP_EVENTS_V1 requires ENVOI_REMOTE_MCP_OAUTH or ENVOI_PROVIDER_CONNECTORS/);
  assert.throws(()=>readOnboardingFlags({...base,ENVOI_MCP_WAKE_V1:'true',ENVOI_PROVIDER_CONNECTORS:'false'}),/ENVOI_MCP_WAKE_V1 requires ENVOI_PROVIDER_CONNECTORS/);
});
test('adding OFF profiles preserves existing public route availability and enabling profiles adds no new route or scope',()=>{
  const asOf='2026-10-24T12:00:00.000Z';const before=routeAvailability(readOnboardingFlags(base),asOf);
  assert.deepEqual(routeAvailability(readOnboardingFlags({...base,...Object.fromEntries(Object.keys(profiles).map(name=>[name,'false']))}),asOf),before);
  assert.deepEqual(routeAvailability(readOnboardingFlags({...base,...Object.fromEntries(Object.keys(profiles).map(name=>[name,'true']))}),asOf),before);
});
test('wakeOrigins is additive, limited to three exact origins and copied into immutable client configuration',()=>{
  const legacy=client();const before=JSON.stringify(legacy);const parsedLegacy=parse(legacy);assert.equal(parsedLegacy.wakeOrigins,undefined);assert.equal(JSON.stringify(legacy),before);
  for(const origins of [[],['https://hooks.provider-config.example.com'],['https://one.provider-config.example.com','https://two.provider-config.example.com','https://three.provider-config.example.com']]){
    const configured=client({wakeOrigins:origins});const parsed=parse(configured);assert.deepEqual(parsed.wakeOrigins,origins);assert.equal(Object.isFrozen(parsed),true);assert.equal(Object.isFrozen(parsed.wakeOrigins),true);origins.push('https://later.provider-config.example.com');assert.notDeepEqual(parsed.wakeOrigins,origins);
  }
  assert.throws(()=>parse(client({wakeOrigins:['https://one.provider-config.example.com','https://two.provider-config.example.com','https://three.provider-config.example.com','https://four.provider-config.example.com']})),/wakeOrigins/);
});
test('wakeOrigins rejects ambiguous, credential-bearing, non-HTTPS and non-origin destinations',()=>{
  const invalid=[
    ['http://hooks.provider-config.example.com'],['ftp://hooks.provider-config.example.com'],['https://127.0.0.1'],['https://192.0.43.11'],['https://[2606:4700::1111]'],
    ['https://hooks.provider-config.example.com/path'],['https://hooks.provider-config.example.com/'],['https://hooks.provider-config.example.com?query=1'],['https://hooks.provider-config.example.com#fragment'],
    ['https://user:pass@hooks.provider-config.example.com'],['https://hooks.provider-config.example.com:8443'],['https://hooks.provider-config.example.com:443'],['https://*.provider-config.example.com'],
    ['https://hooks.provider-config.example.com','https://hooks.provider-config.example.com'],['not a URL'],['https://'],[''],[null],[42],[{}],null,'https://hooks.provider-config.example.com',{}
  ];
  for(const wakeOrigins of invalid)assert.throws(()=>parse(client({wakeOrigins})),/wakeOrigins/,JSON.stringify(wakeOrigins));
  assert.throws(()=>parse(client({connectionRoute:'remote_mcp_oauth',wakeOrigins:['https://hooks.provider-config.example.com']})),/wakeOrigins/);
  assert.throws(()=>parse(client({connectionRoute:'remote_mcp_oauth',wakeOrigins:[]})),/wakeOrigins/);
});
