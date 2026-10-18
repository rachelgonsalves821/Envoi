import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { wakeLimits } from './http-wake-destination.js';

export function createWakeKeys(encoded, now = () => Date.now()) {
  const keys = JSON.parse(encoded || '[]').map(key => ({ ...key, key: crypto.createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' }) }));
  if (keys.some(key => key.key.asymmetricKeyType !== 'ed25519' || !/^[A-Za-z0-9_-]+$/.test(key.kid) || !Number.isFinite(Date.parse(key.activeFrom)) || (key.notAfter && !Number.isFinite(Date.parse(key.notAfter))))) throw new Error('Invalid wake signing keys');
  if (new Set(keys.map(k => k.kid)).size !== keys.length) throw new Error('Duplicate wake key id');
  const live = () => keys.filter(k => !k.notAfter || Date.parse(k.notAfter) > now()).sort((a,b) => Date.parse(b.activeFrom) - Date.parse(a.activeFrom));
  const active = () => live().find(k => Date.parse(k.activeFrom) <= now());
  const validate = () => {
    const list = live();
    if (!active() || list.filter(k => Date.parse(k.activeFrom) > now()).length > 1) throw new Error('Wake requires one active key and at most one next key');
    const historical = [...keys].sort((a,b) => Date.parse(a.activeFrom) - Date.parse(b.activeFrom));
    for (let i = 0; i < historical.length - 1; i++) if (!historical[i].notAfter || Date.parse(historical[i].notAfter) < Date.parse(historical[i+1].activeFrom) + 86400000) throw new Error('Insufficient wake retirement grace');
  };
  validate();
  return {
    jwks: () => ({ keys: live().map(k => ({ ...crypto.createPublicKey(k.key).export({ format: 'jwk' }), kid:k.kid, use:'sig', alg:'EdDSA', status:Date.parse(k.activeFrom) > now() ? 'next' : k === active() ? 'active' : 'retired', ...(k !== active() && Date.parse(k.activeFrom) <= now() ? { notAfter:k.notAfter } : {}) })) }),
    sign(url, bodyText, id) {
      const key = active(); if (!key) throw new Error('No active wake key');
      const timestamp = String(Math.floor(now() / 1000));
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
    const target = new URL(url); let req, timer, connectTimer, done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); clearTimeout(connectTimer); resolve(result); };
    try {
      req = request(target, { method:'POST', headers:{ ...headers, 'content-length':Buffer.byteLength(bodyText) }, agent:false, servername:target.hostname, ca:tls.rootCertificates, minVersion:'TLSv1.2', rejectUnauthorized:true, autoSelectFamily:false,
        lookup: (_host, options, callback) => options?.all ? callback(null, addresses.map(address => ({ address, family:net.isIP(address) }))) : callback(null, addresses[0], net.isIP(addresses[0]))
      }, response => {
        const status = response.statusCode; const retry = [429,503].includes(status) && /^\d+$/.test(String(response.headers['retry-after'] || '')) ? Math.min(1800, Number(response.headers['retry-after'])) : 0;
        let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes >= limits.responseBodyReadMaxBytes) response.destroy(); });
        response.on('error', () => {});
        // Only status/headers determine acknowledgement. Continue a bounded discard in background.
        const bodyTimer = setTimeout(() => response.destroy(), Math.max(1, remainingMs)); bodyTimer.unref?.();
        response.on('close', () => clearTimeout(bodyTimer));
        finish({ status, failureClass:classifyWakeStatus(status), retryAfterSeconds:retry });
      });
      timer = setTimeout(() => { finish({ failureClass:'timeout' }); req.destroy(); }, Math.max(1, remainingMs));
      connectTimer = setTimeout(() => { finish({ failureClass:'timeout' }); req.destroy(); }, Math.min(limits.connectTimeoutMs, remainingMs));
      req.on('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
      req.on('upgrade', (_response, socket) => { socket.destroy(); finish({ status:101, failureClass:'http_rejected' }); });
      req.on('error', error => finish({ failureClass:/CERT|TLS|SSL|VERIFY|SELF_SIGNED/.test(error.code || '') ? 'tls_failed' : 'connect_failed' }));
      req.end(bodyText);
    } catch { finish({ failureClass:'connect_failed' }); req?.destroy(); }
  });
}
