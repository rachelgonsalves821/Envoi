import test from 'node:test';
import assert from 'node:assert/strict';
import { marketingRoute, nonceStaticHtml } from '../src/marketing-routes.js';
import { launch } from './a3-harness.js';

test('marketing routes only expose the intended public pages and assets', () => {
  assert.deepEqual(marketingRoute('/'), { file: 'index.html' });
  assert.deepEqual(marketingRoute('/product/'), { file: 'product/index.html' });
  assert.deepEqual(marketingRoute('/create-account'), { redirect: '/create-account/' });
  assert.deepEqual(marketingRoute('/create-account/'), { file: 'create-account/index.html' });
  assert.deepEqual(marketingRoute('/team/'), { redirect: '/#team' });
  assert.deepEqual(marketingRoute('/agents/muse.svg'), { file: 'agents/muse.svg' });
  assert.equal(marketingRoute('/api/auth/workos/sign-in'), null);
  assert.equal(marketingRoute('/src/server.js'), null);
  assert.equal(marketingRoute('/app'), null);
});

test('setup docs routes map only to built docs pages and the agent index', () => {
  assert.deepEqual(marketingRoute('/docs'), { redirect: '/docs/' });
  assert.deepEqual(marketingRoute('/docs/'), { file: 'docs/index.html' });
  assert.deepEqual(marketingRoute('/docs/hermes'), { redirect: '/docs/hermes/' });
  assert.deepEqual(marketingRoute('/docs/hermes/'), { file: 'docs/hermes/index.html' });
  assert.deepEqual(marketingRoute('/docs/fix/'), { file: 'docs/fix/index.html' });
  assert.deepEqual(marketingRoute('/llms.txt'), { file: 'llms.txt' });
  for (const pathname of ['/docs/../src/server.js', '/docs/%2e%2e/', '/docs/Hermes/', '/docs/a/b/', '/docs/.hidden/', '/docs/-x/', `/docs/${'a'.repeat(41)}/`, '/docs/fix/index.html']) {
    assert.equal(marketingRoute(pathname), null, pathname);
  }
});

test('every inline or external Astro script and stylesheet receives the response nonce', () => {
  const html = '<script>one()</script><script type="module" src="/app.js"></script><style>p{}</style><link rel="stylesheet" href="/style.css">';
  const result = nonceStaticHtml(html, 'test-nonce');
  assert.equal((result.match(/nonce="test-nonce"/g) || []).length, 4);
  assert.equal(nonceStaticHtml(result, 'test-nonce'), result);
});

test('the combined server serves marketing, workspace, assets and legacy routes', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const get = async pathname => fetch(new URL(pathname, server.baseUrl), { redirect: 'manual' });

  const about = await get('/');
  assert.equal(about.status, 200);
  assert.match(about.headers.get('content-type'), /^text\/html/);
  const aboutHtml = await about.text();
  assert.match(aboutHtml, /Break your agents out of their silos/);
  assert.match(aboutHtml, /content="index, follow"/);
  assert.match(aboutHtml, /href="\/create-account\/"/);
  const nonce = about.headers.get('content-security-policy').match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  for (const tag of aboutHtml.match(/<(?:script|style)\b[^>]*>|<link\b[^>]*rel="stylesheet"[^>]*>/g) || []) {
    assert.ok(tag.includes(`nonce="${nonce}"`), `CSP nonce missing from ${tag.slice(0, 100)}`);
  }
  const stylesheet = aboutHtml.match(/href="(\/_astro\/[^\"]+\.css)"/)?.[1];
  assert.ok(stylesheet);
  const css = await get(stylesheet);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.ok((await css.text()).includes('.hero'));

  const product = await get('/product/');
  assert.equal(product.status, 200);
  const productHtml = await product.text();
  assert.match(productHtml, /<title>Product \| Envoi<\/title>/);
  assert.match(productHtml, /data-page="product"/);
  assert.match(productHtml, /content="index, follow"/);
  assert.match(productHtml, /href="\/create-account\/"/);
  const account = await get('/create-account/');
  assert.equal(account.status, 200);
  const accountHtml = await account.text();
  assert.match(accountHtml, /Create your account/);
  assert.match(accountHtml, /sign-up\?returnTo=%2Fapp/);
  assert.equal((await get('/create-account?source=product')).headers.get('location'), '/create-account/?source=product');
  const team = await get('/team/');
  assert.equal(team.status, 301);
  assert.equal(team.headers.get('location'), '/#team');
  assert.equal((await get('/team/?source=footer')).headers.get('location'), '/?source=footer#team');
  assert.equal((await get('/product?source=header')).headers.get('location'), '/product/?source=header');
  const logo = await get('/envoi-logo.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  const app = await get('/app');
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await app.text(), /id="root"/);
  for (const route of ['/claim', '/connect', '/authorize-agent']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  const legacyEnrollment = await get('/?enroll=token');
  assert.equal(legacyEnrollment.status, 302);
  assert.equal(legacyEnrollment.headers.get('location'), '/app?enroll=token');
  const authError = await get('/?auth_error=sign_in_failed');
  assert.equal(authError.status, 200);
  assert.match(await authError.text(), /data-auth-error/);
});

test('the combined server serves the public setup docs, indexable, with the response nonce', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const get = async pathname => fetch(new URL(pathname, server.baseUrl), { redirect: 'manual' });
  for (const pathname of ['/docs/', '/docs/openclaw/', '/docs/hermes/', '/docs/dots/', '/docs/fix/']) {
    const page = await get(pathname);
    assert.equal(page.status, 200, pathname);
    assert.match(page.headers.get('content-type'), /^text\/html/, pathname);
    const html = await page.text();
    assert.match(html, /content="index, follow"/, `${pathname} is indexable`);
    const nonce = page.headers.get('content-security-policy').match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, pathname);
    for (const tag of html.match(/<(?:script|style)\b[^>]*>|<link\b[^>]*rel="stylesheet"[^>]*>/g) || []) assert.ok(tag.includes(`nonce="${nonce}"`), `${pathname}: CSP nonce missing from ${tag.slice(0, 100)}`);
  }
  const fixes = await (await get('/docs/fix/')).text();
  for (const code of ['ENROLLMENT_TOKEN_REJECTED', 'GATEWAY_UNREACHABLE', 'NODE_UNSUPPORTED', 'INSUFFICIENT_SCOPE']) assert.match(fixes, new RegExp(`id="${code}"`), `fix section for ${code}`);
  assert.equal((await get('/docs')).headers.get('location'), '/docs/');
  assert.equal((await get('/docs/hermes')).headers.get('location'), '/docs/hermes/');
  assert.equal((await get('/docs/not-a-page/')).status, 404);
  const index = await get('/llms.txt');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/plain/);
  assert.match(await index.text(), /\/docs\/fix\//);
});
