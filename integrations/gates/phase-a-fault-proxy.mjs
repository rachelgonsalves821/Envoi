// Loopback-only hosted gate faults. Private bytes exist only in bounded memory;
// evidence contains counters, successor equality, or settlement status/code.
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESPONSE = 64 * 1024;
const MAX_SETTLEMENT = 1024 * 1024;
const tokenFields = ['agentApiToken', 'agentTokenExpiresAt', 'agentRefreshToken', 'agentRefreshTokenExpiresAt'];

function boundedBody(stream, limit, done) {
  let chunks = [], size = 0, overflow = false;
  stream.on('data', chunk => {
    size += chunk.length;
    if (size > limit) { overflow = true; chunks = []; }
    else if (!overflow) chunks.push(Buffer.from(chunk));
  });
  stream.once('end', () => { const bytes = overflow ? null : Buffer.concat(chunks); chunks = []; done(bytes); });
}

function successorDigest(bytes) {
  try {
    const value = JSON.parse(bytes);
    if (!tokenFields.every(key => typeof value[key] === 'string' && value[key])) return null;
    return createHash('sha256').update(JSON.stringify(tokenFields.map(key => value[key]))).digest('hex');
  } catch { return null; }
}

function responseCode(bytes) {
  try {
    const code = JSON.parse(bytes).code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null;
  } catch { return null; }
}

export function createFaultProxy(upstreamOrigin, report = () => {}) {
  const upstream = new URL(upstreamOrigin);
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.search || upstream.hash || upstream.pathname !== '/'
    || (upstream.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname))) {
    throw new Error('Use a bare HTTPS upstream origin (HTTP only for local tests)');
  }
  const streams = new Set(), requests = new Set();
  const probes = new Map();
  const counts = { refreshResponsesDropped: 0, sseStreamsCut: 0, sseReconnectsBlocked: 0,
    acknowledgementsFailed: 0, settlementsHeld: 0, settlementsReleased: 0 };
  let blockSse = false, dropRefreshOnce = false, failAckOnce = false, holdSettlement = false;
  let waitingForSuccessor = false, droppedDigest = null, recoveredIdentical = null, held = null, closed = false;
  const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  function trackedRequest(target, options, callback) {
    const request = transport(target, { ...options, timeout: 60_000 }, callback);
    requests.add(request);
    request.once('close', () => requests.delete(request));
    request.on('timeout', () => request.destroy());
    return request;
  }
  function forwardBuffered(pending) {
    return new Promise(resolve => {
      const interrupted = () => {
        if (pending.response && !pending.response.destroyed) pending.response.destroy();
        resolve({ status: 502, code: 'UPSTREAM_UNAVAILABLE' });
      };
      const request = trackedRequest(pending.target, { method: 'POST', headers: pending.headers }, upstreamResponse => {
        upstreamResponse.once('aborted', interrupted);
        upstreamResponse.once('error', interrupted);
        if (pending.response && !pending.response.destroyed) {
          pending.response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(pending.response);
        }
        boundedBody(upstreamResponse, MAX_RESPONSE, bytes => {
          resolve({ status: upstreamResponse.statusCode || 502, code: responseCode(bytes) });
        });
      });
      request.on('error', interrupted);
      request.end(pending.body);
      pending.body = null; pending.headers = null;
    });
  }
  function replay(kind) {
    const pending = probes.get(kind); probes.delete(kind);
    return pending && !closed ? forwardBuffered(pending) : Promise.reject(new Error('No buffered probe'));
  }
  const server = createServer((client, response) => {
    const target = new URL(client.url || '/', upstream);
    if (target.origin !== upstream.origin) { response.writeHead(400).end(); return; }
    const sse = client.method === 'GET' && /^\/api\/inboxes\/[^/]+\/events$/.test(target.pathname);
    const refresh = client.method === 'POST' && target.pathname === '/api/agent-token';
    const acknowledge = client.method === 'POST' && /^\/api\/agent\/work\/[^/]+\/acknowledge$/.test(target.pathname);
    const complete = client.method === 'POST' && /^\/api\/agent\/work\/[^/]+\/complete$/.test(target.pathname);
    const claim = client.method === 'POST' && target.pathname === '/api/agent/work/claim';
    if ((refresh || claim) && client.headers.authorization) {
      // Optional post-revoke probes keep only the latest request of each kind.
      // They are never logged/persisted and are consumed once by explicit replay.
      const kind = refresh ? 'refresh' : 'claim';
      const headers = { ...client.headers, host: upstream.host };
      boundedBody(client, MAX_RESPONSE, body => {
        if (!closed && body !== null) probes.set(kind, { target, headers, body });
      });
    }
    if (sse && blockSse) { counts.sseReconnectsBlocked++; response.destroy(); return; }
    if (acknowledge && failAckOnce) {
      failAckOnce = false; counts.acknowledgementsFailed++; client.resume();
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'GA_ACK_INJECTED' }));
      return;
    }
    if (complete && holdSettlement) {
      holdSettlement = false;
      const pending = { target, headers: { ...client.headers, host: upstream.host }, response, body: null };
      held = pending;
      boundedBody(client, MAX_SETTLEMENT, body => {
        if (closed || held !== pending) return;
        if (body === null) { held = null; response.writeHead(413).end(); return; }
        pending.body = body; counts.settlementsHeld++;
        report({ settlementBuffered: true });
      });
      client.once('aborted', () => { if (held === pending && pending.body === null) held = null; });
      // Keep a fully buffered request even if revoke aborts the connector's fetch.
      return;
    }
    const request = trackedRequest(target, {
      method: client.method, headers: { ...client.headers, host: upstream.host }
    }, upstreamResponse => {
      if (refresh && dropRefreshOnce && upstreamResponse.statusCode === 200) {
        dropRefreshOnce = false;
        boundedBody(upstreamResponse, MAX_RESPONSE, bytes => {
          droppedDigest = successorDigest(bytes); waitingForSuccessor = true;
          counts.refreshResponsesDropped++; response.destroy();
          report({ refreshResponsesDropped: counts.refreshResponsesDropped });
        });
        return;
      }
      if (refresh && waitingForSuccessor && upstreamResponse.statusCode === 200) {
        boundedBody(upstreamResponse, MAX_RESPONSE, bytes => {
          const digest = successorDigest(bytes);
          recoveredIdentical = droppedDigest !== null && digest === droppedDigest;
          droppedDigest = null; waitingForSuccessor = false;
          report({ recoveredIdentical });
        });
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      if (sse) {
        const stream = { client, response, request, upstreamResponse };
        streams.add(stream);
        upstreamResponse.once('close', () => streams.delete(stream));
      }
      upstreamResponse.pipe(response);
    });
    request.on('error', () => { if (!response.destroyed) response.destroy(); });
    response.once('close', () => request.destroy());
    client.pipe(request);
  });
  return {
    listen: port => new Promise((resolve, reject) => {
      // Tests explicitly select 0; the operator CLI requires a fixed nonzero port.
      if (!Number.isInteger(port) || port < 0 || port > 65535) { reject(new Error('Supply a valid listen port')); return; }
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject); resolve(`http://127.0.0.1:${server.address().port}`);
      });
    }),
    armLostRefresh: () => {
      if (dropRefreshOnce || waitingForSuccessor) throw new Error('A lost refresh comparison is already pending');
      recoveredIdentical = null; dropRefreshOnce = true;
    },
    armFailAck: () => { failAckOnce = true; },
    armHoldSettlement: () => {
      if (holdSettlement || held) throw new Error('A settlement is already pending');
      holdSettlement = true;
    },
    releaseSettlement: () => {
      if (!held?.body || closed) return Promise.reject(new Error('No fully buffered settlement to release'));
      const pending = held; held = null; counts.settlementsReleased++;
      return forwardBuffered(pending);
    },
    replayRefresh: () => replay('refresh'),
    replayClaim: () => replay('claim'),
    cutSse: () => {
      blockSse = true;
      for (const stream of [...streams]) {
        counts.sseStreamsCut++;
        stream.response.destroy(); stream.upstreamResponse.destroy(); stream.request.destroy(); stream.client.destroy();
      }
    },
    restoreSse: () => { blockSse = false; },
    status: () => ({ ...counts, recoveredIdentical, sseBlocked: blockSse, lostRefreshArmed: dropRefreshOnce,
      failAckArmed: failAckOnce, holdSettlementArmed: holdSettlement, settlementBuffered: Boolean(held?.body), activeSse: streams.size }),
    close: () => new Promise(resolve => {
      closed = true; held = null; probes.clear(); droppedDigest = null; waitingForSuccessor = false;
      for (const request of requests) request.destroy();
      server.closeAllConnections(); server.close(resolve);
    })
  };
}

export function proxyArguments(args) {
  const values = new Map();
  if (args.length !== 4) throw new Error('Supply --origin and --port');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--origin', '--port'].includes(args[i]) || values.has(args[i])) throw new Error('Invalid proxy arguments');
    values.set(args[i], args[i + 1]);
  }
  const port = Number(values.get('--port'));
  if (!/^\d+$/.test(values.get('--port') || '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply a fixed port from 1 to 65535');
  return { origin: values.get('--origin'), port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { origin, port } = proxyArguments(process.argv.slice(2));
    const proxy = createFaultProxy(origin, evidence => console.log(JSON.stringify(evidence)));
    const url = await proxy.listen(port);
    console.log(`Phase A fault proxy on ${url}; route only the disposable connector through it.`);
    console.log('Commands: lost-refresh, hold-settlement, release, replay-refresh, replay-claim, fail-ack-once, cut-sse, restore-sse, status, exit');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.on('line', async line => {
      try {
        const command = line.trim();
        if (command === 'lost-refresh') proxy.armLostRefresh();
        else if (command === 'hold-settlement') proxy.armHoldSettlement();
        else if (command === 'release') { console.log(JSON.stringify(await proxy.releaseSettlement())); return; }
        else if (command === 'replay-refresh') { console.log(JSON.stringify(await proxy.replayRefresh())); return; }
        else if (command === 'replay-claim') { console.log(JSON.stringify(await proxy.replayClaim())); return; }
        else if (command === 'fail-ack-once') proxy.armFailAck();
        else if (command === 'cut-sse') proxy.cutSse();
        else if (command === 'restore-sse') proxy.restoreSse();
        else if (command === 'exit') { input.close(); await proxy.close(); return; }
        else if (command !== 'status') { console.log('Unknown command'); return; }
        console.log(JSON.stringify(proxy.status()));
      } catch { console.log('Command unavailable; check fault state with status'); }
    });
  } catch {
    console.error('Usage: node integrations/gates/phase-a-fault-proxy.mjs --origin https://<staging-host> --port <fixed loopback port>');
    process.exitCode = 2;
  }
}
