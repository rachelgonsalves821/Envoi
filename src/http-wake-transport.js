import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { wakeLimits } from './http-wake-destination.js';

export function createWakeKeys(encoded, now = () => Date.now()) {
  const keys = JSON.parse(encoded || '[]').map(key => ({ ...key, key: crypto.createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' }) }));
  if (keys.some(key => key.key.asymmetricKeyType !== 'ed25519' || !/^[A-Za-z0-9._-]{1,64}$/.test(key.kid) || !Number.isFinite(Date.parse(key.activeFrom)) || (key.notAfter && !Number.isFinite(Date.parse(key.notAfter))))) throw new Error('Invalid wake signing keys');
  if (new Set(keys.map(k => k.kid)).size !== keys.length) throw new Error('Duplicate wake key id');
  const live = (at=now()) => keys.filter(k => !k.notAfter || Date.parse(k.notAfter) > at).sort((a,b) => Date.parse(b.activeFrom) - Date.parse(a.activeFrom));
  const active = (at=now()) => live(at).find(k => Date.parse(k.activeFrom) <= at);
  const validate = (at=now()) => {
    const list = live(at), signer=active(at);
    if (!signer || list.filter(k => Date.parse(k.activeFrom) > at).length > 1) throw new Error('Wake requires one active key and at most one next key');
    if(list.filter(k=>Date.parse(k.activeFrom)===Date.parse(signer.activeFrom)).length!==1)throw new Error('Wake signing key activation times must be unambiguous');
    const historical = [...keys].sort((a,b) => Date.parse(a.activeFrom) - Date.parse(b.activeFrom));
    for (let i = 0; i < historical.length - 1; i++) if (!historical[i].notAfter || Date.parse(historical[i].notAfter) < Date.parse(historical[i+1].activeFrom) + 86400000) throw new Error('Insufficient wake retirement grace');
  };
  validate();
  return {
    jwks: () => { const at=now();validate(at);const signer=active(at);return { keys: live(at).map(k => ({ ...crypto.createPublicKey(k.key).export({ format: 'jwk' }), kid:k.kid, use:'sig', alg:'EdDSA', status:Date.parse(k.activeFrom) > at ? 'next' : k === signer ? 'active' : 'retired', ...(k !== signer && Date.parse(k.activeFrom) <= at ? { notAfter:k.notAfter } : {}) })) }; },
    sign(url, bodyText, id) {
      const at=now();const key = active(at); if (!key) throw new Error('No active wake key');
      const timestamp = String(Math.floor(at / 1000));
      const bytes = Buffer.from(`envoi-wake/1\n${key.kid}\n${timestamp}\n${id}\n${url}\n${bodyText}`);
      return { 'content-type':'application/json', 'user-agent':'Envoi-Wake/1', 'envoi-wake-id':id, 'envoi-wake-timestamp':timestamp, 'envoi-wake-key-id':key.kid, 'envoi-wake-signature':`v1=${crypto.sign(null, bytes, key.key).toString('base64url')}` };
    }
  };
}
export function classifyWakeStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return 'redirect_rejected';
  if (status === 410) return 'receiver_gone';
  if ([408,425,429].includes(status) || status >= 500) return 'http_retryable';
  return 'http_rejected';
}
export function createWakeTransport({ request = https.request, limits = wakeLimits } = {}) {
  return ({ url, addresses, headers, bodyText, remainingMs = limits.deliveryTimeoutMs }) => new Promise(resolve => {
    const target = new URL(url); let req, timer, connectTimer, done = false, responseStream, responseResult;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); clearTimeout(connectTimer); resolve(result); };
    try {
      req = request(target, { method:'POST', headers:{ ...headers, 'content-length':Buffer.byteLength(bodyText) }, agent:false, servername:target.hostname, ca:tls.rootCertificates, minVersion:'TLSv1.2', rejectUnauthorized:true, autoSelectFamily:false,
        lookup: (_host, options, callback) => options?.all ? callback(null, addresses.map(address => ({ address, family:net.isIP(address) }))) : callback(null, addresses[0], net.isIP(addresses[0]))
      }, response => {
        responseStream = response;
        const status = response.statusCode; const retry = [429,503].includes(status) && /^\d+$/.test(String(response.headers['retry-after'] || '')) ? Math.min(1800, Number(response.headers['retry-after'])) : 0;
        responseResult = { status, failureClass:classifyWakeStatus(status), retryAfterSeconds:retry };
        clearTimeout(connectTimer);
        let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes >= limits.responseBodyReadMaxBytes) response.destroy(); });
        response.on('error', () => { response.destroy(); finish(responseResult); });
        response.on('end', () => { response.destroy(); finish(responseResult); });
        response.on('close', () => finish(responseResult));
        // Preserve the status result while draining. The original whole-attempt timer stays
        // armed; neither the socket lifetime nor its admission slot gets a fresh deadline.
      });
      timer = setTimeout(() => { responseStream?.destroy(); req.destroy(); finish(responseResult || { failureClass:'timeout' }); }, Math.max(1, remainingMs));
      connectTimer = setTimeout(() => { finish({ failureClass:'timeout' }); req.destroy(); }, Math.min(limits.connectTimeoutMs, remainingMs));
      req.on('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
      req.on('upgrade', (_response, socket) => { socket.destroy(); finish({ status:101, failureClass:'http_rejected' }); });
      req.on('error', error => { responseStream?.destroy(); finish(responseResult || { failureClass:/CERT|TLS|SSL|VERIFY|SELF_SIGNED/.test(error.code || '') ? 'tls_failed' : 'connect_failed' }); });
      req.end(bodyText);
    } catch { finish({ failureClass:'connect_failed' }); req?.destroy(); }
  });
}
