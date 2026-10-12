// Loopback-only fault injector for the real-host Phase A gate. Never logs or
// persists headers, bodies, cookies, credentials, or upstream responses.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createFaultProxy(upstreamOrigin) {
  const upstream = new URL(upstreamOrigin);
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.search || upstream.hash || upstream.pathname !== '/'
    || (upstream.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname))) {
    throw new Error('Use a bare HTTPS upstream origin (HTTP only for local tests)');
  }
  const streams = new Set();
  const counts = { refreshResponsesDropped: 0, sseStreamsCut: 0, sseReconnectsBlocked: 0 };
  let blockSse = false, dropRefreshOnce = false;
  const server = createServer((client, response) => {
    const target = new URL(client.url || '/', upstream);
    if (target.origin !== upstream.origin) { response.writeHead(400).end(); return; }
    const sse = client.method === 'GET' && /^\/api\/inboxes\/[^/]+\/events$/.test(target.pathname);
    const refresh = client.method === 'POST' && target.pathname === '/api/agent-token';
    if (sse && blockSse) { counts.sseReconnectsBlocked++; response.destroy(); return; }
    const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: client.method, headers: { ...client.headers, host: upstream.host }, timeout: 60_000
    }, upstreamResponse => {
      if (refresh && dropRefreshOnce && upstreamResponse.statusCode === 200) {
        dropRefreshOnce = false;
        upstreamResponse.resume();
        upstreamResponse.once('end', () => { counts.refreshResponsesDropped++; response.destroy(); });
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      if (sse) {
        const stream = { client, response, request, upstreamResponse };
        streams.add(stream);
        upstreamResponse.once('close', () => streams.delete(stream));
      }
      upstreamResponse.pipe(response);
    });
    request.on('timeout', () => request.destroy(new Error('upstream timeout')));
    request.on('error', () => { if (!response.destroyed) response.destroy(); });
    response.once('close', () => request.destroy());
    client.pipe(request);
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(`http://127.0.0.1:${server.address().port}`);
      });
    }),
    armLostRefresh: () => { dropRefreshOnce = true; },
    cutSse: () => {
      blockSse = true;
      for (const stream of [...streams]) {
        counts.sseStreamsCut++;
        stream.response.destroy(); stream.upstreamResponse.destroy(); stream.request.destroy(); stream.client.destroy();
      }
    },
    restoreSse: () => { blockSse = false; },
    status: () => ({ ...counts, sseBlocked: blockSse, lostRefreshArmed: dropRefreshOnce, activeSse: streams.size }),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--origin') {
    console.error('Usage: node integrations/gates/phase-a-fault-proxy.mjs --origin https://<staging-host>');
    process.exitCode = 2;
  } else {
    const proxy = createFaultProxy(process.argv[3]);
    const url = await proxy.listen();
    console.log(`Phase A fault proxy on ${url}; route only the disposable connector through it.`);
    console.log('Commands: lost-refresh, cut-sse, restore-sse, status, exit');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.on('line', async line => {
      const command = line.trim();
      if (command === 'lost-refresh') proxy.armLostRefresh();
      else if (command === 'cut-sse') proxy.cutSse();
      else if (command === 'restore-sse') proxy.restoreSse();
      else if (command === 'exit') { input.close(); await proxy.close(); return; }
      else if (command !== 'status') { console.log('Unknown command'); return; }
      console.log(JSON.stringify(proxy.status()));
    });
  }
}
