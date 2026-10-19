import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createProviderBrowserPollHttp } from '../src/provider-browser-poll-http.js';

async function browser() {
  const handler = createProviderBrowserPollHttp({ enabled: () => true, origin: () => 'https://envoi.test' });
  let source = '';
  await handler({ method: 'GET', headers: {} }, { removeHeader() {}, setHeader() {}, writeHead() {}, end(value) { source = value; } }, new URL('https://envoi.test/agent-gateway/ui.js'));
  const element = () => ({ textContent: '', hidden: true, children: [], append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; } });
  const forms = Object.fromEntries(['check', 'next', 'ack', 'empty'].map(kind => {
    const f = { ...element(), dataset: { kind, api: kind === 'ack' ? '/api/agent-gateway/notifications/ack' : kind === 'empty' ? '/api/agent-gateway/session/end' : '/api/agent-gateway/check' },
      elements: Object.fromEntries((kind === 'check' ? ['runId'] : kind === 'next' ? ['runId','cursor'] : kind === 'ack' ? ['runId','notificationRefs'] : []).map(name => [name, { value: name === 'runId' ? 'run-initial' : '' }])),
      button: { disabled: false }, querySelector() { return this.button; }, addEventListener(_type, handler) { this.submit = () => handler({ preventDefault() {} }); } };
    return [kind, f];
  }));
  const nodes = Object.fromEntries(['result','status','work','continue'].map(id => [id, element()]));
  const responses = [], requests = [];
  const document = { querySelector: selector => selector.includes('meta') ? { content: 'csrf' } : forms[selector.match(/kind="(.*?)"/)[1]],
    querySelectorAll: () => Object.values(forms), getElementById: id => nodes[id], createElement: () => element() };
  vm.runInNewContext(source, { document, crypto: { randomUUID: () => 'new-run' }, FormData: class { constructor(form) { return Object.entries(form.elements).map(([k,v]) => [k,v.value]); } },
    fetch: async (path, options) => { requests.push({ path, payload: JSON.parse(options.body) }); const response = responses.shift(); if (response instanceof Error) throw response; return { ok: response.ok !== false, json: async () => response }; } });
  return { forms, nodes, responses, requests };
}
const page = (nextCursor = 'cursor-next') => ({ state: 'active', runId: 'run-initial', nextCursor, retryAfterSeconds: 1800,
  items: [{ senderAddress: 'peer@envoi.test', summary: '<script>untrusted</script>', notificationRef: 'opaque-ref' }] });

test('browser-only pagination retains the run and requires explicit alert presentation before continuing', async () => {
  const b = await browser(); b.responses.push(page()); await b.forms.check.submit();
  assert.equal(b.forms.ack.hidden, false); assert.equal(b.forms.next.hidden, false); assert.equal(b.forms.next.button.disabled, true);
  assert.equal(b.requests.length, 1, 'render does not automatically acknowledge');
  assert.equal(b.nodes.work.children[0].children[1].textContent, '<script>untrusted</script>', 'rendered as text');
  b.responses.push({ state: 'presentation_recorded' }); await b.forms.ack.submit();
  assert.equal(b.forms.next.button.disabled, false);
  assert.deepEqual(b.requests[1].payload, { runId: 'run-initial', notificationRefs: ['opaque-ref'] });
  b.responses.push(page('cursor-third')); await b.forms.next.submit();
  assert.equal(b.forms.next.button.disabled, true, 'continuation waits for this page alert too');
  assert.deepEqual(b.requests[2].payload, { runId: 'run-initial', cursor: 'cursor-next' });
  b.responses.push({ state: 'presentation_recorded' }); await b.forms.ack.submit();
  b.responses.push({ ...page(null), items: [] }); await b.forms.next.submit();
  b.responses.push(page(null)); await b.forms.check.submit();
  assert.equal(b.requests.at(-1).payload.runId, 'run_newrun', 'a later check gets a fresh run ID');
});

test('browser transport retry preserves the request; lifecycle denial clears stale work and controls', async () => {
  const b = await browser(); b.responses.push(new Error('lost response')); await b.forms.check.submit();
  b.responses.push(page()); await b.forms.check.submit();
  assert.deepEqual(b.requests[0], b.requests[1], 'same run on uncertain response');
  b.responses.push({ ok: false, code: 'AGENT_PAUSED' }); await b.forms.ack.submit();
  assert.equal(b.nodes.work.children.length, 0); assert.equal(b.forms.ack.hidden, true); assert.equal(b.forms.next.hidden, true);
  b.responses.push({ state: 'ended' }); await b.forms.empty.submit();
  assert.equal(Object.values(b.forms).every(f => f.hidden), true);
});
