// Gate B-local: a loopback HTTPS front end for a local `npm start` server. The private envoi-link
// helper accepts only an https: origin, as in production, so the local gate runs the real helper
// against https://localhost:<port> with a locally generated certificate that the helper and
// connector processes trust through NODE_EXTRA_CA_CERTS. It listens on 127.0.0.1 only, forwards
// only to a loopback http: target, and streams both directions, so SSE stays live.
//
//   node scripts/local-https-proxy.mjs --cert <cert.pem> --key <key.pem> [--listen 8443] [--target http://127.0.0.1:8787]
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function parseTarget(value) {
  const target = new URL(value);
  if (target.protocol !== 'http:' || !loopbackHosts.has(target.hostname) || target.pathname !== '/' || target.search || target.username || target.password) {
    throw new Error('--target must be a loopback http origin such as http://127.0.0.1:8787');
  }
  return target;
}

export function createLocalHttpsProxy({ cert, key, target }) {
  const upstream = parseTarget(target);
  return https.createServer({ cert, key }, (req, res) => {
    const forward = http.request({
      hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80, method: req.method, path: req.url,
      // The Host header stays what the client sent (localhost:<listen>), so the server's origin
      // checks see the same origin as ENVOI_PUBLIC_URL.
      headers: req.headers
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    forward.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('The local Envoi server is not reachable.'); }
      else res.destroy();
    });
    req.on('aborted', () => forward.destroy());
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
  try {
    const certPath = option('--cert');
    const keyPath = option('--key');
    if (!certPath || !keyPath) throw new Error('Usage: node scripts/local-https-proxy.mjs --cert <cert.pem> --key <key.pem> [--listen 8443] [--target http://127.0.0.1:8787]');
    const listen = Number(option('--listen', '8443'));
    if (!Number.isInteger(listen) || listen < 1 || listen > 65535) throw new Error('--listen must be a port number');
    const proxy = createLocalHttpsProxy({ cert: await readFile(certPath), key: await readFile(keyPath), target: option('--target', 'http://127.0.0.1:8787') });
    proxy.listen(listen, '127.0.0.1', () => console.log(`Local HTTPS for Envoi on https://localhost:${listen} -> ${option('--target', 'http://127.0.0.1:8787')}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
