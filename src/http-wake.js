import crypto from 'node:crypto';
import path from 'node:path';
import { createWakeDestination, wakeError } from './http-wake-destination.js';
import { createWakeKeys, createWakeTransport } from './http-wake-transport.js';
import { createWakeAdmission } from './http-wake-limits.js';

const epochPath = 'config/http-wake-epoch';
const root = 'http-wake';
const subPath = id => path.join(root, 'subscriptions', `${id}.json`);
const eventPath = id => path.join(root, 'queue', `${id}.json`);
const lock = inboxId => `inbox:${inboxId}:mutations`;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const live = record => ['queued','processing','retrying'].includes(record.status);
const iso = n => new Date(n).toISOString();
const retryable = new Set(['timeout','connect_failed','tls_failed','address_rejected','interrupted','http_retryable']);
const challengeRetryable = new Set(['interrupted','http_retryable']);
const schedule = [10,30,120,600,1800];
const publicSub = sub => Object.fromEntries(['id','installationId','agentId','url','status','endedReason','endedAt','createdAt','activatedAt','expiresAt','challengeExpiresAt','replacesSubscriptionId','delivery'].map(key => [key, sub[key]]));
export function createHttpWake({ store, enabled = false, installationsEnabled = false, env = process.env, facts, audit = async () => {}, now = () => new Date().toISOString(), random = Math.random, resolveDestination, transport, signingKeys } = {}) {
  if (enabled && !installationsEnabled) throw new Error('ENVOI_HTTP_WAKE_V1 requires ENVOI_INSTALLATIONS_V2');
  if (enabled && ['1','true'].includes(env.NODE_USE_ENV_PROXY)) throw new Error('Wake cannot use environment proxy transport');
  const destination = createWakeDestination({ env });
  const resolve = resolveDestination || destination.resolve;
  const keys = enabled ? (signingKeys || createWakeKeys(env.ENVOI_WAKE_SIGNING_KEYS, () => Date.parse(now()))) : null;
  const send = transport || createWakeTransport();
  const time = () => Date.parse(now());
  const admission = createWakeAdmission({store,now:time});
  const subs = () => store.listJson(path.join(root, 'subscriptions'));
  const events = () => store.listJson(path.join(root, 'queue'));
  const save = sub => store.putJson(subPath(sub.id), sub);
  function available() { if (!enabled) throw wakeError(404, 'FEATURE_DISABLED'); }
  async function endRecord(sub, reason, at = now()) {
    if (sub.status === 'ended') return sub;
    sub.status = 'ended'; sub.endedReason = reason; sub.endedAt = at; sub.challengeExpiresAt = null; sub.challengeHash = null; sub.dirty = {};
    await save(sub);
    for (const event of await events()) if (event.subscriptionId === sub.id && live(event) && event.status !== 'processing') { event.status = 'cancelled'; event.finishedAt = at; await store.putJson(eventPath(event.id), event); }
    await audit(sub.inboxId, 'agent.wake_subscription_ended', { agentId:sub.agentId, installationId:sub.installationId, subscriptionId:sub.id, endedReason:reason }, at);
    return sub;
  }
  async function derive(sub) {
    if (!sub || sub.status === 'ended') return sub;
    const epoch = await store.getJson(epochPath);
    if (epoch && sub.createdAt < epoch.epoch) return endRecord(sub, 'feature_disabled', epoch.epoch);
    const { family, agent } = await facts(sub);
    if (!family || family.revokedAt || !agent || !['active','paused'].includes(agent.status) || agent.onboardingStatus !== 'approved') return endRecord(sub, 'credential_ended', family?.revokedAt || agent?.revokedAt || agent?.removedAt || now());
    if (sub.status === 'pending' && Date.parse(sub.challengeExpiresAt) <= time()) return endRecord(sub, 'challenge_expired', sub.challengeExpiresAt);
    if (sub.status === 'active' && Date.parse(sub.expiresAt) <= time()) return endRecord(sub, 'expired', sub.expiresAt);
    return sub;
  }
  async function queue(sub, type, reason, challenge) {
    const lane = type === 'wake.challenge' ? 'challenge' : type === 'wake.work_available' ? 'work' : 'control';
    const existing = (await events()).find(event => event.subscriptionId === sub.id && event.lane === lane && live(event));
    if (existing) { sub.dirty ||= {}; sub.dirty[lane] = { type, reason }; await save(sub); return; }
    sub.sequence = Number(sub.sequence || 0) + 1;
    const body = { type, version:1, id:`wake_evt_${crypto.randomBytes(18).toString('base64url')}`, subscriptionId:sub.id, sequence:sub.sequence, ...(reason ? { reason } : {}), createdAt:now(), ...(challenge ? { challenge, expiresAt:sub.challengeExpiresAt } : {}) };
    const event = { ...body, inboxId:sub.inboxId, agentId:sub.agentId, lane, bodyText:JSON.stringify(body), status:'queued', attempts:0, availableAt:iso(time() + (challenge ? 2000 : 0)), deadline:challenge ? sub.challengeExpiresAt : iso(time()+3600000) };
    await save(sub); await store.putJson(eventPath(event.id), event);
  }
  async function startup() {
    await store.withTransaction(['http-wake:epoch'], async () => {
      const previous = await store.getJson(epochPath); const at = now();
      const move = !enabled || !previous || Date.parse(previous.activeUntil) <= time();
      const record = { epoch:move ? at : previous.epoch, activeUntil:enabled ? iso(time()+21600000) : at };
      await store.putJson(epochPath, record);
      if (move) await audit(null, 'http_wake.epoch_moved', { cause:enabled ? 'active_until_passed' : 'flag_off_at_startup' }, at);
    });
  }
  async function heartbeat() { if (!enabled) return; await store.withTransaction(['http-wake:epoch'], async () => { const record = await store.getJson(epochPath); if (!record || Date.parse(record.activeUntil) <= time()) return startup(); await store.putJson(epochPath, { ...record, activeUntil:iso(time()+21600000) }); }); }
  async function owned(identity, id) { const sub = await store.getJson(subPath(id)); if (!sub || sub.inboxId !== identity.inboxId || sub.agentId !== identity.agentId || (identity.installationId && sub.installationId !== identity.installationId)) throw wakeError(404,'WAKE_SUBSCRIPTION_NOT_FOUND'); return derive(sub); }
  async function create(identity, { url }) {
    available(); destination.canonical(url);
    const counterPath = path.join(root, 'create-limits', `${identity.agentId}.json`);
    const counter = await store.getJson(counterPath, { entries:[] });
    counter.entries = counter.entries.filter(item => item.at > time()-3600000);
    const prior = counter.entries.filter(item => item.installationId === identity.installationId);
    const limited = prior.length >= 5 || counter.entries.length >= 10;
    const oldest = Math.min(...(prior.length >= 5 ? prior : counter.entries).map(item => item.at));
    counter.entries.push({ at:time(), installationId:identity.installationId }); await store.putJson(counterPath,counter);
    if (limited) throw Object.assign(wakeError(429,'RATE_LIMITED','wake_subscription_create_limit'), { retryAfter:Math.max(1,Math.ceil((oldest+3600000-time())/1000)) });
    const resolved = await resolve(url);
    const existing = (await subs()).filter(sub => sub.installationId === identity.installationId && sub.agentId === identity.agentId);
    for (const sub of existing) await derive(sub);
    for (const sub of existing.filter(sub => sub.status === 'pending')) await endRecord(sub,'superseded');
    const challenge = `envoi_wake_challenge_${crypto.randomBytes(32).toString('base64url')}`;
    const sub = { id:`wake_sub_${crypto.randomBytes(18).toString('base64url')}`, ...identity, url:resolved.url, status:'pending', endedReason:null, endedAt:null, createdAt:now(), activatedAt:null, expiresAt:null, challengeExpiresAt:iso(time()+600000), replacesSubscriptionId:existing.find(sub => sub.status === 'active')?.id || null, delivery:{ state:'unverified', lastAttemptAt:null,lastSuccessAt:null,consecutiveFailures:0,lastFailureClass:null }, challengeHash:hash(challenge),sequence:0,dirty:{} };
    await queue(sub,'wake.challenge',null,challenge);
    await audit(sub.inboxId,'agent.wake_subscription_created',{ agentId:sub.agentId,installationId:sub.installationId,subscriptionId:sub.id,origin:new URL(sub.url).origin },now());
    return { subscription:publicSub(sub) };
  }
  async function activate(identity,id,{ challenge }) {
    available(); const sub = await owned(identity,id);
    if (sub.status === 'ended') throw wakeError(409,'WAKE_SUBSCRIPTION_ENDED',sub.endedReason);
    const supplied = Buffer.from(hash(String(challenge))); const stored = Buffer.from(sub.challengeHash);
    if (supplied.length !== stored.length || !crypto.timingSafeEqual(supplied,stored)) throw wakeError(400,'WAKE_CHALLENGE_INVALID');
    if (sub.status === 'active') return { subscription:publicSub(sub) };
    for (const old of await subs()) if (old.installationId === sub.installationId && old.agentId === sub.agentId && old.status === 'active') await endRecord(old,'replaced');
    sub.status='active'; sub.activatedAt=now(); sub.expiresAt=iso(time()+2592000000); sub.challengeExpiresAt=null;
    if(sub.challengeDelivery)sub.delivery={...sub.challengeDelivery};
    await save(sub);
    for(const event of await events())if(event.subscriptionId===sub.id&&event.lane==='challenge'&&['queued','retrying'].includes(event.status)){event.status='cancelled';event.finishedAt=now();await store.putJson(eventPath(event.id),event);}
    const { agent } = await facts(sub); if (agent.status !== 'paused') await queue(sub,'wake.work_available','subscription_activated');
    await audit(sub.inboxId,'agent.wake_subscription_activated',{ agentId:sub.agentId,installationId:sub.installationId,subscriptionId:sub.id },now());
    return { subscription:publicSub(sub) };
  }
  async function listFor(identity) {
    const records = [];
    for (const sub of await subs()) if (sub.inboxId === identity.inboxId && sub.agentId === identity.agentId && (!identity.installationId || sub.installationId === identity.installationId)) records.push(await derive(sub));
    const active = records.filter(sub => sub.status !== 'ended').sort((a,b) => (a.status === 'pending' ? 0 : 1)-(b.status === 'pending' ? 0 : 1));
    const ended = records.filter(sub => sub.status === 'ended').sort((a,b)=>b.endedAt.localeCompare(a.endedAt)).slice(0,5);
    return [...active,...ended];
  }
  async function trigger({ inboxId, agentId, type='wake.work_available', reason }) {
    if (!enabled) return;
    for (const sub of await subs()) if (sub.inboxId === inboxId && sub.agentId === agentId) {
      await derive(sub); if (sub.status !== 'active') continue;
      const { family,agent } = await facts(sub);
      if (Date.parse(family.refreshExpiresAt) <= time() || (type === 'wake.work_available' && agent.status === 'paused')) continue;
      if (reason === 'work_due') { if (sub.lastWorkDueAt && time()-Date.parse(sub.lastWorkDueAt)<60000) continue; sub.lastWorkDueAt=now(); }
      await queue(sub,type,reason);
    }
  }
  async function pause(inboxId,agentId) {
    for (const sub of await subs()) if (sub.inboxId === inboxId && sub.agentId === agentId && sub.status === 'active') {
      sub.dirty ||= {}; delete sub.dirty.work; await save(sub);
      for (const event of await events()) if (event.subscriptionId === sub.id && event.lane === 'work' && ['queued','retrying'].includes(event.status)) { event.status='cancelled';event.finishedAt=now();await store.putJson(eventPath(event.id),event); }
    }
    await trigger({ inboxId,agentId,type:'wake.control_changed',reason:'agent_paused' });
  }
  async function finish(event,sub,result) {
    const at=time(); event.lastFailureClass=result.failureClass || null;
    const retry = (event.lane === 'challenge' ? challengeRetryable : retryable).has(result.failureClass);
    const delay = Math.max((schedule[Math.min(event.attempts-1,4)] * (0.8+random()*0.4)),result.retryAfterSeconds || 0)*1000;
    const next = Date.parse(event.startedAt)+delay;
    if (retry && event.attempts < (event.lane === 'challenge' ? 3 : 6) && next <= Date.parse(event.deadline) && sub.status !== 'ended') { event.status='retrying';event.availableAt=iso(Math.max(at,next)); }
    else { event.status=result.notSent ? 'cancelled' : !result.failureClass ? 'acknowledged' : retry ? 'exhausted' : 'failed';event.finishedAt=now(); }
    event.claimToken=null; event.lockedUntil=null; await store.putJson(eventPath(event.id),event);
    if(sub.status!=='ended'&&!result.notSent){sub.lastTransportFailure=['timeout','connect_failed','tls_failed','address_rejected'].includes(result.failureClass);await save(sub);}
    if(sub.status!=='ended'&&event.lane==='challenge'&&!result.failureClass&&!result.notSent){sub.challengeDelivery={state:'healthy',lastAttemptAt:event.startedAt,lastSuccessAt:now(),consecutiveFailures:0,lastFailureClass:null};if(sub.activatedAt)sub.delivery={...sub.challengeDelivery};await save(sub);}
    if (sub.status !== 'ended' && sub.activatedAt && event.lane !== 'challenge' && !result.notSent) {
      sub.delivery.lastAttemptAt=event.startedAt;
      if (!result.failureClass) sub.delivery={ state:'healthy',lastAttemptAt:event.startedAt,lastSuccessAt:now(),consecutiveFailures:0,lastFailureClass:null };
      else if (!live(event)) sub.delivery={ ...sub.delivery,state:'failing',consecutiveFailures:sub.delivery.consecutiveFailures+1,lastFailureClass:result.failureClass };
      await save(sub);
      if (result.failureClass === 'receiver_gone') await endRecord(sub,'receiver_gone');
      else if (sub.delivery.consecutiveFailures>=10 && at-Date.parse(sub.delivery.lastSuccessAt || sub.activatedAt)>=86400000) await endRecord(sub,'delivery_failed');
    }
    if (!live(event) && sub.status === 'active' && sub.dirty?.[event.lane]) { const dirty=sub.dirty[event.lane];delete sub.dirty[event.lane];await save(sub);await queue(sub,dirty.type,dirty.reason); }
  }
  async function runOnce() {
    if (!enabled) return false;
    const candidates=(await events()).filter(live).sort((a,b)=>a.availableAt.localeCompare(b.availableAt));
    for (const candidate of candidates) {
      let claimed;
      await store.withTransaction([lock(candidate.inboxId)],async()=>{
        const event=await store.getJson(eventPath(candidate.id)); if (!event || !live(event)) return;
        const sub=await derive(await store.getJson(subPath(event.subscriptionId))); if (!sub) return;
        if (event.status === 'processing') { if (Date.parse(event.lockedUntil)>time()) return; await finish(event,sub,{failureClass:'interrupted'});return; }
        if (Date.parse(event.availableAt)>time()) return;
        const {family,agent}=await facts(sub);
        if (sub.status === 'ended' || Date.parse(family?.refreshExpiresAt)<=time() || (event.lane==='work' && agent?.status==='paused') || (sub.status==='pending' && event.lane!=='challenge') || (sub.status==='active' && event.lane==='challenge')) { await finish(event,sub,{notSent:true});return; }
        if (Date.parse(event.deadline)<time()) { event.attempts=6;event.startedAt=now();await finish(event,sub,{failureClass:'interrupted'});return; }
        event.status='processing';event.attempts++;event.startedAt=now();event.claimToken=crypto.randomUUID();event.lockedUntil=iso(time()+15000);await store.putJson(eventPath(event.id),event);claimed={event,sub};
      });
      if (!claimed) continue;
      const {event,sub}=claimed;let result;
      try { destination.canonical(sub.url); } catch { result={failureClass:'url_rejected'}; }
      if (!result) {
        try {
          const resolved=await resolve(sub.url);
          const admitted=await admission.admit({subscriptionId:sub.id,eventId:event.id,host:new URL(sub.url).hostname,addresses:resolved.addresses,token:event.claimToken,limited:event.lane==='challenge'||sub.lastTransportFailure===true});
          if(!admitted){await store.withTransaction([lock(sub.inboxId)],async()=>{const current=await store.getJson(eventPath(event.id));if(current?.claimToken===event.claimToken){current.status='queued';current.attempts--;current.availableAt=iso(time()+1000);current.claimToken=null;await store.putJson(eventPath(event.id),current);}});continue;}
          // Recheck control after asynchronous DNS, immediately before the external effect.
          let permitted=false;
          await store.withTransaction([lock(sub.inboxId)],async()=>{
            const queued=await store.getJson(eventPath(event.id));
            const current=await derive(await store.getJson(subPath(sub.id)));
            if(!current)return;
            const state=await facts(current);
            permitted=queued?.status==='processing' && queued.claimToken===event.claimToken
              && Date.parse(queued.lockedUntil)>time() && Date.parse(queued.deadline)>=time()
              && time()-Date.parse(queued.startedAt)<10000 && current.status!=='ended'
              && Date.parse(state.family?.refreshExpiresAt)>time()
              && !(event.lane==='work' && state.agent?.status==='paused')
              && (event.lane==='challenge' ? current.status==='pending' : current.status==='active');
          });
          if (!permitted) result={notSent:true};
          else result=await send({...resolved,bodyText:event.bodyText,headers:keys.sign(sub.url,event.bodyText,event.id),remainingMs:Math.max(1,10000-(time()-Date.parse(event.startedAt)))});
        } catch { result={failureClass:'address_rejected'}; }
      }
      await admission.release(event.claimToken);
      await store.withTransaction([lock(sub.inboxId)],async()=>{
        const current=await store.getJson(eventPath(event.id));if(current?.claimToken!==event.claimToken)return;
        // A result arriving beyond its lease is uncertain even if this process knows it. The
        // durable queue recovers it as interrupted, exactly as a different worker would.
        if(Date.parse(current.lockedUntil)<=time())result={failureClass:'interrupted'};
        await finish(current,await derive(await store.getJson(subPath(sub.id))),result);
      });
      return true;
    }
    return false;
  }
  return { enabled, startup, heartbeat, create, activate, trigger, pause, runOnce,
    keys:()=>{available();return keys.jwks();},
    async end(identity,id){available();return {subscription:publicSub(await endRecord(await owned(identity,id),'ended_by_host'))};},
    async ownerRevoke(inboxId,agentId,id){available();return {subscription:publicSub(await endRecord(await owned({inboxId,agentId},id),'revoked_by_owner'))};},
    async list(identity){available();return {installationId:identity.installationId,subscriptions:(await listFor(identity)).map(publicSub)};},
    async ownerList(inboxId,agentId){available();return {agentId,subscriptions:(await listFor({inboxId,agentId})).map(publicSub)};},
    async status(identity){if(!enabled)return {available:false,version:1,subscription:null};const records=await listFor(identity);const sub=records.find(s=>s.status==='active') || records.find(s=>s.status==='pending') || records[0];return {available:true,version:1,subscription:sub?{id:sub.id,status:sub.status,endedReason:sub.endedReason,expiresAt:sub.expiresAt}:null};},
    async endForFamily(inboxId,agentId,familyId){for(const sub of await subs())if(sub.inboxId===inboxId&&sub.agentId===agentId&&sub.familyId===familyId)await endRecord(sub,'credential_ended');},
    async cleanup(){for(const sub of await subs())await store.withTransaction([lock(sub.inboxId)],async()=>{const current=await derive(await store.getJson(subPath(sub.id)));if(current.status==='ended'&&time()-Date.parse(current.endedAt)>2592000000)await store.deleteJson(subPath(current.id));});for(const event of await events())if(!live(event)&&event.finishedAt&&time()-Date.parse(event.finishedAt)>86400000)await store.deleteJson(eventPath(event.id));}
  };
}
