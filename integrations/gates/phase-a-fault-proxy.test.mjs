import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createFaultProxy, proxyArguments } from './phase-a-fault-proxy.mjs';

test('drops one successful refresh response, cuts SSE, and leaves REST available', async () => {
  let refreshes = 0;
  const upstream = createServer((req, res) => {
    if (req.url === '/api/agent-token') { refreshes++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"secret":"must-not-be-logged"}'); return; }
    if (req.url === '/api/inboxes/inbox_1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return; }
    res.writeHead(200).end('ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createFaultProxy(`http://127.0.0.1:${upstream.address().port}`);
  const url = await proxy.listen(0);
  try {
    assert.equal(await (await fetch(`${url}/health`)).text(), 'ok');
    proxy.armLostRefresh();
    await assert.rejects(fetch(`${url}/api/agent-token`, { method: 'POST', body: '{}' }));
    assert.equal(refreshes, 1);
    assert.equal(await (await fetch(`${url}/api/agent-token`, { method: 'POST', body: '{}' })).status, 200);
    assert.equal(proxy.status().refreshResponsesDropped, 1);
    const stream = await fetch(`${url}/api/inboxes/inbox_1/events`);
    assert.equal(stream.status, 200);
    proxy.cutSse();
    await assert.rejects(stream.text());
    await assert.rejects(fetch(`${url}/api/inboxes/inbox_1/events`));
    assert.equal(await (await fetch(`${url}/ready`)).text(), 'ok');
    assert.equal(proxy.status().sseStreamsCut, 1);
    assert.equal(proxy.status().sseReconnectsBlocked, 1);
    proxy.restoreSse();
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

async function upstreamFixture(handler, report = () => {}) {
  const upstream = createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createFaultProxy(upstreamOrigin, report);
  const url = await proxy.listen(0);
  return { proxy, url, upstreamOrigin, close: async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); } };
}

async function waitFor(check) {
  const deadline = Date.now() + 3_000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Fault fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

function encodedJson(value, encoding) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (encoding === 'gzip') return gzipSync(bytes);
  if (encoding === 'deflate') return deflateSync(bytes);
  if (encoding === 'br') return brotliCompressSync(bytes);
  return bytes;
}

for (const [droppedEncoding, recoveredEncoding] of [['identity', 'gzip'], ['gzip', 'identity'], ['gzip', 'gzip'], ['deflate', 'deflate'], ['br', 'br'], ['gzip', 'br']]) {
  for (const changedField of [null, 'agentApiToken', 'agentRefreshToken', 'agentTokenExpiresAt', 'agentRefreshTokenExpiresAt']) {
    test(`compressed successor comparison ${droppedEncoding}/${recoveredEncoding}, changed=${changedField}`, async () => {
      const successor = { agentApiToken: 'private-access', agentTokenExpiresAt: '2030-01-01T00:15:00.000Z',
        agentRefreshToken: 'private-refresh', agentRefreshTokenExpiresAt: '2030-02-01T00:00:00.000Z' };
      let calls = 0;
      const evidence = [];
      const fixture = await upstreamFixture((request, response) => {
        request.resume();
        calls++;
        const value = calls === 1 ? successor : { extra: 'ignored', ...Object.fromEntries(Object.entries(successor).reverse()) };
        if (calls > 1 && changedField) value[changedField] += '-changed';
        const encoding = calls === 1 ? droppedEncoding : recoveredEncoding;
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding }).end(encodedJson(value, encoding));
      }, value => evidence.push(value));
      try {
        fixture.proxy.armLostRefresh();
        await assert.rejects(fetch(`${fixture.url}/api/agent-token`, { method: 'POST' }));
        const response = await fetch(`${fixture.url}/api/agent-token`, { method: 'POST' });
        assert.equal(response.headers.get('content-encoding'), recoveredEncoding);
        const decoded = await response.json();
        assert.equal(decoded.agentApiToken, successor.agentApiToken + (changedField === 'agentApiToken' ? '-changed' : ''));
        assert.equal(fixture.proxy.status().recoveredIdentical, changedField === null);
        assert.equal(fixture.proxy.status().refreshResponsesDropped, 1);
        assert.deepEqual(evidence, [{ refreshResponsesDropped: 1 }, { recoveredIdentical: changedField === null }]);
        assert.ok(!JSON.stringify([evidence, fixture.proxy.status()]).match(/private-access|private-refresh|digest|2030-/));
      } finally { await fixture.close(); }
    });
  }
}

for (const encoding of ['gzip', 'deflate', 'br']) {
  test(`compressed ${encoding} replay retains the server revocation code`, async () => {
    let revoked = false;
    const fixture = await upstreamFixture((request, response) => {
      request.resume();
      response.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json', 'content-encoding': encoding })
        .end(encodedJson({ code: revoked ? 'CREDENTIAL_REVOKED' : 'SUCCESS', secret: 'private-response' }, encoding));
    });
    try {
      await (await fetch(`${fixture.url}/api/agent-token`, { method: 'POST', headers: { authorization: 'Bearer private-fixture' }, body: '{}' })).json();
      revoked = true;
      assert.deepEqual(await fixture.proxy.replayRefresh(), { status: 401, code: 'CREDENTIAL_REVOKED' });
      assert.ok(!JSON.stringify(fixture.proxy.status()).includes('private-'));
    } finally { await fixture.close(); }
  });
}

for (const failure of ['unsupported-encoding', 'malformed-gzip', 'oversized-decoded']) {
  test(`invalid comparison fails closed: ${failure}`, async () => {
    const successor = { agentApiToken: 'private-access', agentTokenExpiresAt: '2030-01-01T00:15:00.000Z',
      agentRefreshToken: 'private-refresh', agentRefreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
      ...(failure === 'oversized-decoded' ? { padding: 'a'.repeat(65 * 1024) } : {}) };
    const encoding = failure === 'unsupported-encoding' ? 'unsupported' : 'gzip';
    const bytes = failure === 'malformed-gzip' ? Buffer.from(JSON.stringify(successor)) : encodedJson(successor, encoding);
    const fixture = await upstreamFixture((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding }).end(bytes);
    });
    try {
      fixture.proxy.armLostRefresh();
      await assert.rejects(fetch(`${fixture.url}/api/agent-token`, { method: 'POST' }));
      const response = await fetch(`${fixture.url}/api/agent-token`, { method: 'POST' });
      await response.arrayBuffer().catch(() => undefined);
      assert.equal(fixture.proxy.status().recoveredIdentical, false);
      assert.equal(fixture.proxy.status().refreshResponsesDropped, 1);
    } finally { await fixture.close(); }
  });
}

for (const changedField of [null, 'agentApiToken', 'agentRefreshToken', 'agentTokenExpiresAt', 'agentRefreshTokenExpiresAt']) {
  test(`lost refresh compares all four fields, changed=${changedField}, with no digest or credential output`, async () => {
    const fields = { agentApiToken: 'private-access', agentTokenExpiresAt: '2026-10-13T12:15:00.000Z',
      agentRefreshToken: 'private-refresh', agentRefreshTokenExpiresAt: '2026-11-13T12:00:00.000Z' };
    let calls = 0; const evidence = [];
    const f = await upstreamFixture((req, res) => {
      calls++;
      const response = calls === 1 ? fields : { extra: 'unrelated', ...Object.fromEntries(Object.entries(fields).reverse()) };
      if (calls > 1 && changedField) response[changedField] += '-changed';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    }, value => evidence.push(value));
    try {
      f.proxy.armLostRefresh();
      await assert.rejects(fetch(`${f.url}/api/agent-token`, { method: 'POST' }));
      assert.equal(f.proxy.status().recoveredIdentical, null);
      assert.throws(() => f.proxy.armLostRefresh());
      assert.equal(await (await fetch(`${f.url}/api/agent-token`, { method: 'POST' })).json().then(value => value.agentApiToken), fields.agentApiToken + (changedField === 'agentApiToken' ? '-changed' : ''));
      assert.equal(f.proxy.status().recoveredIdentical, changedField === null);
      assert.deepEqual(evidence, [{ refreshResponsesDropped: 1 }, { recoveredIdentical: changedField === null }]);
      assert.ok(!JSON.stringify([f.proxy.status(), evidence]).match(/private-access|private-refresh|digest|2026-/));
    } finally { await f.close(); }
  });
}

test('lost-refresh ignores an unsuccessful response and an invalid body cannot prove equality', async () => {
  let calls = 0;
  const f = await upstreamFixture((req, res) => { calls++; res.writeHead(calls === 1 ? 503 : 200).end('{}'); });
  try {
    f.proxy.armLostRefresh();
    assert.equal((await fetch(`${f.url}/api/agent-token`, { method: 'POST' })).status, 503);
    assert.equal(f.proxy.status().lostRefreshArmed, true);
    await assert.rejects(fetch(`${f.url}/api/agent-token`, { method: 'POST' }));
    await (await fetch(`${f.url}/api/agent-token`, { method: 'POST' })).text();
    assert.equal(f.proxy.status().recoveredIdentical, false);
  } finally { await f.close(); }
});

test('holds completion through client abort, then forwards once after revoke and exposes status/code only', async () => {
  let revoked = false, completions = 0;
  const f = await upstreamFixture((req, res) => {
    if (!req.url.endsWith('/complete')) { res.writeHead(200).end('{}'); return; }
    completions++;
    assert.equal(req.headers.authorization, 'Bearer private-credential');
    assert.equal(req.headers.host, new URL(f.upstreamOrigin).host);
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert.equal(body, '{"leaseToken":"private-lease"}');
      res.writeHead(revoked ? 401 : 201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: revoked ? 'CREDENTIAL_REVOKED' : 'SUCCESS', secret: 'not evidence' }));
    });
  });
  try {
    f.proxy.armHoldSettlement();
    const controller = new AbortController();
    const request = fetch(`${f.url}/api/agent/work/work_1/complete`, {
      method: 'POST', headers: { authorization: 'Bearer private-credential' },
      body: '{"leaseToken":"private-lease"}', signal: controller.signal
    });
    const rejection = assert.rejects(request);
    await waitFor(() => f.proxy.status().settlementBuffered);
    assert.equal(completions, 0);
    assert.throws(() => f.proxy.armHoldSettlement());
    controller.abort(); await rejection; revoked = true;
    assert.deepEqual(await f.proxy.releaseSettlement(), { status: 401, code: 'CREDENTIAL_REVOKED' });
    assert.equal(completions, 1);
    assert.equal(f.proxy.status().settlementBuffered, false);
    await assert.rejects(f.proxy.releaseSettlement());
    assert.ok(!JSON.stringify(f.proxy.status()).match(/private-|secret|leaseToken|authorization/));
  } finally { await f.close(); }
});

test('injects one acknowledge 503 before upstream effect, leaving fail and subsequent acknowledge available', async () => {
  const paths = [];
  const f = await upstreamFixture((req, res) => { paths.push(req.url); res.writeHead(200).end('{}'); });
  try {
    f.proxy.armFailAck();
    await fetch(`${f.url}/api/agent/work/work_1/renew`, { method: 'POST' });
    const failure = await fetch(`${f.url}/api/agent/work/work_1/acknowledge`, { method: 'POST', body: '{}' });
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { code: 'GA_ACK_INJECTED' });
    assert.ok(!paths.includes('/api/agent/work/work_1/acknowledge'));
    await fetch(`${f.url}/api/agent/work/work_1/fail`, { method: 'POST' });
    assert.equal((await fetch(`${f.url}/api/agent/work/work_1/acknowledge`, { method: 'POST' })).status, 200);
    assert.equal(f.proxy.status().acknowledgementsFailed, 1);
    assert.equal(paths.filter(value => value.endsWith('/acknowledge')).length, 1);
  } finally { await f.close(); }
});

test('rejects an oversized held completion without contacting upstream', async () => {
  let calls = 0;
  const f = await upstreamFixture((req, res) => { calls++; res.writeHead(201).end('{}'); });
  try {
    f.proxy.armHoldSettlement();
    assert.equal((await fetch(`${f.url}/api/agent/work/work_1/complete`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal(calls, 0);
    assert.equal(f.proxy.status().settlementBuffered, false);
    await assert.rejects(f.proxy.releaseSettlement());
  } finally { await f.close(); }
});

test('refuses private response text as a settlement code', async () => {
  const f = await upstreamFixture((req, res) => { res.writeHead(401).end('{"code":"envoi_access_private","message":"private message"}'); });
  try {
    f.proxy.armHoldSettlement();
    const result = fetch(`${f.url}/api/agent/work/work_1/complete`, { method: 'POST', body: '{}' });
    await waitFor(() => f.proxy.status().settlementBuffered);
    assert.deepEqual(await f.proxy.releaseSettlement(), { status: 401, code: null });
    await (await result).text();
  } finally { await f.close(); }
});

test('closing the proxy discards a held settlement and aborts the waiting client', async () => {
  let calls = 0;
  const f = await upstreamFixture((req, res) => { calls++; res.writeHead(201).end('{}'); });
  f.proxy.armHoldSettlement();
  const rejection = assert.rejects(fetch(`${f.url}/api/agent/work/work_1/complete`, { method: 'POST', body: '{}' }));
  await waitFor(() => f.proxy.status().settlementBuffered);
  await f.close(); await rejection;
  assert.equal(calls, 0);
  assert.equal(f.proxy.status().settlementBuffered, false);
  await assert.rejects(f.proxy.releaseSettlement());
});

test('requires an explicit stable operator port and can restart on it without changing apiUrl', async () => {
  for (const args of [[], ['--origin', 'https://staging.test'], ['--origin', 'https://staging.test', '--port', '0'],
    ['--origin', 'https://staging.test', '--port', '65536'], ['--origin', 'https://staging.test', '--port', 'NaN']]) assert.throws(() => proxyArguments(args));
  assert.deepEqual(proxyArguments(['--port', '9876', '--origin', 'https://staging.test']), { origin: 'https://staging.test', port: 9876 });
  const first = createFaultProxy('http://127.0.0.1:1'); const url = await first.listen(0);
  await first.close();
  const second = createFaultProxy('http://127.0.0.1:1');
  try { assert.equal(await second.listen(Number(new URL(url).port)), url); }
  finally { await second.close(); }
});

test('retains a body-authenticated SDK refresh without adding a bearer header', async () => {
  let revoked = false;
  const calls = [];
  const f = await upstreamFixture((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push([req.url, body]);
      res.writeHead(revoked ? 401 : 200).end(JSON.stringify({ code: revoked ? 'CREDENTIAL_REVOKED' : 'SUCCESS' }));
    });
  });
  try {
    const first = JSON.stringify({ grantType: 'refresh_token', agentRefreshToken: 'fixture-refresh-first', rotationId: 'fixture-rotation-first' });
    const latest = JSON.stringify({ grantType: 'refresh_token', agentRefreshToken: 'fixture-refresh-latest', rotationId: 'fixture-rotation-latest' });
    for (const body of [first, latest]) await (await fetch(`${f.url}/api/agent-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
    await (await fetch(`${f.url}/api/agent/work/claim`, { method: 'POST', body: '{}' })).text();
    await assert.rejects(f.proxy.replayClaim());
    revoked = true;
    assert.deepEqual(await f.proxy.replayRefresh(), { status: 401, code: 'CREDENTIAL_REVOKED' });
    assert.deepEqual(calls.at(-1), ['/api/agent-token', latest]);
    await assert.rejects(f.proxy.replayRefresh());
    assert.ok(!JSON.stringify(f.proxy.status()).includes('fixture-refresh'));
  } finally { await f.close(); }
});

test('post-revoke refresh and claim probes preserve the latest private request and print only status/code', async () => {
  let revoked = false; const calls = [];
  const f = await upstreamFixture((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-credential');
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push([req.url, body]);
      res.writeHead(revoked ? 401 : 200).end(JSON.stringify({ code: revoked ? 'CREDENTIAL_REVOKED' : 'SUCCESS', secret: 'not evidence' }));
    });
  });
  try {
    for (const route of ['/api/agent-token', '/api/agent/work/claim']) {
      await (await fetch(`${f.url}${route}`, { method: 'POST', headers: { authorization: 'Bearer private-credential' }, body: '{"private":"first"}' })).text();
      await (await fetch(`${f.url}${route}`, { method: 'POST', headers: { authorization: 'Bearer private-credential' }, body: '{"private":"latest"}' })).text();
    }
    revoked = true;
    assert.deepEqual(await f.proxy.replayRefresh(), { status: 401, code: 'CREDENTIAL_REVOKED' });
    assert.deepEqual(await f.proxy.replayClaim(), { status: 401, code: 'CREDENTIAL_REVOKED' });
    assert.deepEqual(calls.slice(-2), [['/api/agent-token', '{"private":"latest"}'], ['/api/agent/work/claim', '{"private":"latest"}']]);
    await assert.rejects(f.proxy.replayRefresh()); await assert.rejects(f.proxy.replayClaim());
    assert.ok(!JSON.stringify(f.proxy.status()).includes('private'));
  } finally { await f.close(); }
});
