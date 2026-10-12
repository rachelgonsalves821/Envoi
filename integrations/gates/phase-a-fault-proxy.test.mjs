import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFaultProxy } from './phase-a-fault-proxy.mjs';

test('drops one successful refresh response, cuts SSE, and leaves REST available', async () => {
  let refreshes = 0;
  const upstream = createServer((req, res) => {
    if (req.url === '/api/agent-token') { refreshes++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"secret":"must-not-be-logged"}'); return; }
    if (req.url === '/api/inboxes/inbox_1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return; }
    res.writeHead(200).end('ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createFaultProxy(`http://127.0.0.1:${upstream.address().port}`);
  const url = await proxy.listen();
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
