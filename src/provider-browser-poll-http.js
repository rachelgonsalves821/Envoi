import { gatewayClosed, gatewayContract, gatewayError } from './provider-browser-poll.js';

export const gatewayCookies = Object.freeze({ pending: '__Host-envoi_agent_pair', session: '__Host-envoi_agent_gateway' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(seconds))}`;
function cookies(req) {
  const result = {};
  for (const piece of String(req.headers.cookie || '').split(';')) {
    const [name, ...rest] = piece.trim().split('=');
    if (Object.hasOwn(result, name)) throw gatewayError(401, 'GATEWAY_SESSION_REQUIRED');
    result[name] = rest.join('=');
  }
  return result;
}
async function input(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw gatewayError(400, 'GATEWAY_REQUEST_INVALID'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8'), type = String(req.headers['content-type'] || '').split(';')[0];
  try {
    if (type === 'application/json') return { payload: JSON.parse(raw), csrf: req.headers['x-envoi-gateway-csrf'] };
    if (type === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams(raw);
      if ([...form.keys()].length !== 2 || form.getAll('payload').length !== 1 || form.getAll('csrf').length !== 1) throw new Error();
      return { payload: JSON.parse(form.get('payload')), csrf: form.get('csrf') };
    }
  } catch { /* closed decoding, no raw response echo */ }
  throw gatewayError(400, 'GATEWAY_REQUEST_INVALID');
}
const script = `document.querySelectorAll('form[data-api]').forEach(form=>form.addEventListener('submit',async event=>{
event.preventDefault(); const fields=new FormData(form); let payload={};
for(const [key,value] of fields)payload[key]=value;
if(form.dataset.kind==='pair')payload={requestedName:payload.requestedName,requestedPermissions:['receive_agent_messages'],runtime:{type:payload.runtimeType,version:null}};
if(form.dataset.kind==='empty')payload={};
if(form.dataset.kind==='ack')payload={runId:payload.runId,notificationRefs:JSON.parse(payload.notificationRefs)};
const out=document.getElementById('result');try{const r=await fetch(form.dataset.api,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','X-Envoi-Gateway-CSRF':document.querySelector('meta[name="csrf"]').content},body:JSON.stringify(payload)});
const data=await r.json();out.textContent=JSON.stringify(data,null,2);document.getElementById('status').textContent=r.ok?(data.state==='presentation_recorded'?'Owner alert recorded. The work remains pending.':data.state==='owner_confirmed'?'Delegation confirmed. Continue in the assistant browser.':data.state==='connected'?'Connected to '+data.agentAddress:data.items?data.items.length+' new work item(s).':'Request completed.'):data.code==='AGENT_PAUSED'?'This agent is paused.':data.code==='GATEWAY_SESSION_EXPIRED'?'Your session expired. Ask the owner to reconnect.':'Unable to complete this step: '+data.code;
if(r.ok)document.getElementById('continue').hidden=false;
if(data.verificationCode){document.getElementById('status').textContent='Claim code: '+data.verificationCode+' — Comparison phrase: '+data.comparisonPhrase+'. The owner approves this in their own browser.';}
if(data.items){const list=document.getElementById('work');list.replaceChildren();for(const item of data.items){const li=document.createElement('li');const title=document.createElement('strong');title.textContent=item.senderAddress;const p=document.createElement('p');p.textContent=item.summary;li.append(title,p);list.append(li);}const ack=document.querySelector('form[data-kind="ack"]');if(ack){ack.hidden=!data.items.length;ack.elements.runId.value=data.runId;ack.elements.notificationRefs.value=JSON.stringify(data.items.map(x=>x.notificationRef));}}
}catch{out.textContent='Request did not complete. Preserve this browser and retry the same operation; do not register again.'}}));`;
const styles = `:root{font-family:system-ui,sans-serif;color:#172c32;background:#f0f4f2}*{box-sizing:border-box}body{margin:0;padding:48px 20px}main{max-width:760px;margin:auto;background:#fff;border:1px solid #d6e0da;border-radius:20px;padding:36px;box-shadow:0 16px 50px #153a2310}h1{font-size:2rem;letter-spacing:-.04em;margin-top:0}p{line-height:1.6;color:#425b60}label{display:block;margin:18px 0;font-weight:600}input:not([type=hidden]){display:block;width:100%;padding:12px;margin-top:6px;border:1px solid #91aaa1;border-radius:8px;font:inherit}button{border:0;background:#146846;color:white;border-radius:9px;padding:12px 18px;font:inherit;cursor:pointer;margin:8px 0}button:hover{background:#0c4e32}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #f2ac45;outline-offset:3px}a{color:#146846}ul{list-style:none;padding:0}li{padding:18px;border:1px solid #d6e0da;border-radius:10px;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem}details{margin-top:24px}#status{padding:12px 0;font-weight:600}@media(max-width:500px){body{padding:16px 10px}main{padding:22px}}`;

export function createProviderBrowserPollHttp({ gateway, enabled, origin, owner, ownerConfirm, policy, rateLimit = () => true }) {
  function secure(req, res) {
    for (const name of ['access-control-allow-origin', 'access-control-allow-credentials']) res.removeHeader(name);
    res.setHeader('cache-control', 'private, no-store'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin !== origin(req) || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.authorization
        || req.rawHeaders?.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length) throw gatewayError(403, 'GATEWAY_CSRF_INVALID');
    }
  }
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const form = (api, kind, fields, label) => `<form data-api="${api}" data-kind="${kind}">${fields}<button>${label}</button></form>`;
  const field = (name, label, value = '', hidden = false) => `<label>${escape(label)}<input name="${name}" value="${escape(value)}"${hidden ? ' type="hidden"' : ' required'}></label>`;
  function page(res, title, csrf, content) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="csrf" content="${escape(csrf)}"><title>${escape(title)}</title><link rel="stylesheet" href="/agent-gateway/ui.css"></head><body><main><h1>${escape(title)}</h1>${content}<p id="status" role="status" aria-live="polite"></p><ul id="work"></ul><details><summary>Agent-readable result</summary><pre id="result"></pre></details><p id="continue" hidden>Use the same browser to <a href="/agent-gateway/connect">continue pairing</a> or <a href="/agent-gateway/inbox">check the delegated inbox</a>.</p></main><script src="/agent-gateway/ui.js" defer></script></body></html>`);
  }
  return async function handle(req, res, url) {
    const gatewayPath = url.pathname.startsWith('/api/agent-gateway/') || url.pathname.startsWith('/agent-gateway/');
    const discovery = url.pathname === '/api/onboarding/routes' && url.searchParams.has('contract');
    const policyMatch = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/agents\/([^/]+)\/installations\/([^/]+)\/poll-policy$/);
    if (!gatewayPath && !discovery && !policyMatch) return false;
    secure(req, res);
    try {
      if (discovery) {
        if (req.method !== 'GET' || url.searchParams.get('contract') !== 'provider-browser-poll-v1' || [...url.searchParams.keys()].length !== 1) throw gatewayError(400, 'GATEWAY_REQUEST_INVALID');
        res.setHeader('cache-control', 'public, max-age=60');
        json(res, { contract: gatewayContract, gatewayAvailable: enabled(), allowedPairs: enabled() ? [{ connectionRoute: 'authenticated_rest', deliveryMode: 'poll', activationAuthority: 'gateway' }] : [] }); return true;
      }
      if (!enabled()) throw gatewayError(404, 'FEATURE_DISABLED');
      if (!await rateLimit(req)) throw gatewayError(429, 'RATE_LIMITED', { retryAfterSeconds: 60 });
      if (req.method === 'GET' && url.pathname === '/agent-gateway/ui.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(script); return true; }
      if (req.method === 'GET' && url.pathname === '/agent-gateway/ui.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); res.end(styles); return true; }
      if (req.method === 'GET' && url.pathname === '/agent-gateway/owner') {
        const context = await owner(req);
        page(res, 'Approve delegated browser', context.csrf, `<p>First approve the displayed code at <a href="/claim">Envoi owner claim</a> in your own signed-in browser. Compare the code and phrase with the intended assistant browser. This authorizes read/notify only, a 30-minute check cadence, alerts to you on the host, and a maximum seven-day browser session. It grants no send or settlement authority.</p>${form('/api/agent-gateway/owner-confirm', 'owner', field('verificationCode', 'Claim code') + field('comparisonPhrase', 'Comparison phrase'), 'Confirm this browser delegation')}`); return true;
      }
      const jar = cookies(req), pending = jar[gatewayCookies.pending], session = jar[gatewayCookies.session];
      if (req.method === 'GET' && url.pathname === '/agent-gateway/connect') {
        if (session) { const view = await gateway.session(session); page(res, 'Connected delegation', view.csrf, `<p>${escape(view.agentAddress)}</p><a href="/agent-gateway/inbox">Open delegated inbox</a>`); return true; }
        const view = await gateway.setup(pending); res.setHeader('set-cookie', cookie(gatewayCookies.pending, view.secret, (Date.parse(view.expiresAt) - Date.now()) / 1000));
        const content = view.state === 'new' ? form('/api/agent-gateway/pairings', 'pair', field('requestedName', 'Agent name') + field('runtimeType', 'Host type: muse or instinct', 'muse'), 'Request owner claim')
          : `<p>State: ${escape(view.state)}</p><p>Claim code: ${escape(view.verificationCode)}</p><p>Comparison phrase: ${escape(view.comparisonPhrase)}</p><p>The person must approve at <a href="/claim">/claim</a>, then confirm at <a href="/agent-gateway/owner">/agent-gateway/owner</a> in their own signed-in browser.</p>${form('/api/agent-gateway/pairing/activate', 'activate', field('operationId', '', view.operationId, true), 'Continue after owner confirmation')}`;
        page(res, 'Connect a delegated browser', view.csrf, content); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/agent-gateway/pairing') { json(res, await gateway.pairing(pending)); return true; }
      if (req.method === 'GET' && ['/api/agent-gateway/session', '/agent-gateway/inbox'].includes(url.pathname)) {
        const view = await gateway.session(session);
        if (url.pathname.endsWith('/session')) json(res, view);
        else page(res, 'Your agent’s pending work', view.csrf, `<p>${escape(view.agentAddress)} — ${escape(view.state)}</p><p>This connection can read pending work and notify you. It cannot send replies or mark work complete. Scheduled checks require your separate approval.</p>${form('/api/agent-gateway/check', 'check', field('runId', '', `run_${cryptoId()}`, true), 'Check for new work')}${form('/api/agent-gateway/notifications/ack', 'ack', field('runId', '', '', true) + field('notificationRefs', '', '[]', true), 'Confirm the owner alert was sent')}${form('/api/agent-gateway/session/renew', 'empty', '', 'Keep this connection active')}${form('/api/agent-gateway/session/end', 'empty', '', 'Sign out')}`);
        return true;
      }
      if (req.method !== 'POST') throw gatewayError(405, 'GATEWAY_REQUEST_INVALID');
      const { payload, csrf } = await input(req); let result;
      if (policyMatch) { result = await policy(req, policyMatch, payload, csrf); }
      else if (url.pathname === '/api/agent-gateway/owner-confirm') { result = await ownerConfirm(req, payload, csrf); }
      else if (url.pathname === '/api/agent-gateway/pairings') { result = await gateway.begin(pending, csrf, payload, { req }); }
      else if (url.pathname === '/api/agent-gateway/pairing/activate') {
        result = await gateway.activate(pending, csrf, payload);
        res.setHeader('set-cookie', [cookie(gatewayCookies.session, result.secret, (Date.parse(result.expiresAt) - Date.now()) / 1000), cookie(gatewayCookies.pending, '', 0)]);
        const { secret: _secret, ...safe } = result; result = safe;
      } else if (url.pathname === '/api/agent-gateway/check') result = await gateway.check(session, csrf, payload);
      else if (url.pathname === '/api/agent-gateway/notifications/ack') result = await gateway.acknowledge(session, csrf, payload);
      else if (url.pathname === '/api/agent-gateway/session/renew') result = await gateway.renew(session, csrf, payload);
      else if (url.pathname === '/api/agent-gateway/session/end') { result = await gateway.end(session, csrf, payload); res.setHeader('set-cookie', cookie(gatewayCookies.session, '', 0)); }
      else throw gatewayError(403, 'GATEWAY_SCOPE_DENIED');
      json(res, result); return true;
    } catch (err) {
      if (['GATEWAY_SESSION_EXPIRED', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED'].includes(err.code)) res.setHeader('set-cookie', [cookie(gatewayCookies.session, '', 0), cookie(gatewayCookies.pending, '', 0)]);
      if (err.publicFields?.retryAfterSeconds) res.setHeader('retry-after', String(err.publicFields.retryAfterSeconds));
      const code = err.code || 'GATEWAY_TEMPORARILY_UNAVAILABLE';
      json(res, { error: code, code, guidance: err.statusCode === 401 ? 'owner_reconnect' : 'check_state', ...(err.publicFields?.retryAfterSeconds ? { retryAfterSeconds: err.publicFields.retryAfterSeconds } : {}) }, err.statusCode || 503);
      return true;
    }
  };
}
function cryptoId() { return globalThis.crypto.randomUUID().replaceAll('-', ''); }
