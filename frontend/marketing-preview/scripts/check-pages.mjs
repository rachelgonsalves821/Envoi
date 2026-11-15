import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const pages = new Map([
  ['/', await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')],
  ['/product/', await readFile(new URL('../dist/product/index.html', import.meta.url), 'utf8')],
  ['/create-account/', await readFile(new URL('../dist/create-account/index.html', import.meta.url), 'utf8')]
]);
const about = pages.get('/');
const product = pages.get('/product/');
const account = pages.get('/create-account/');
const legacyTeam = await readFile(new URL('../dist/team/index.html', import.meta.url), 'utf8');
assert.match(legacyTeam, /\/#team/);
assert.doesNotMatch(legacyTeam, /class="team-grid"/);
assert.match(about, /id="team"/);
assert.doesNotMatch(product, /id="team"|Rachel Gonsalves|Je Sai Kailash Pulipati/);
assert.match(about, /data-page="about"/);
assert.match(product, /data-page="product"/);
assert.match(account, /<h1 id="account-title">Create your account<\/h1>/);
assert.match(account, /href="(?:https:\/\/www\.envoi-agents\.com)?\/api\/auth\/workos\/sign-up\?returnTo=%2Fapp"/);
assert.match(about, /href="\/create-account\/"[^>]*>Create your account/);
assert.match(product, /href="\/create-account\/"[^>]*>Create your account/);
assert.match(about, /id="how-it-works"/);
assert.match(about, /data-benefit-grid/);
assert.doesNotMatch(about, /data-thread|id="your-view"|id="oversight"/);
assert.match(product, /data-thread/);
assert.match(product, /id="your-view"/);
assert.doesNotMatch(product, /id="oversight"|Set the terms|An agreement, with the context attached/);
assert.match(product, /<h1 id="product-title">Track your agents\u2019 work in different email threads<\/h1>/);
assert.doesNotMatch(product, /Native messaging between agents with human oversight\./);
assert.doesNotMatch(product, /id="how-it-works"|id="collaboration"/);
const aboutMain = about.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
assert.doesNotMatch(aboutMain, /Native messaging|scoped file access|approval gates|Shared audit trails|Marketplace policy|data-inbox-row|comparison-chart|plain-columns/i);
assert.match(aboutMain, /Break your agents out of their silos/);
for (const heading of ['Connect your agents', 'Work across agent harnesses', 'Set and verify permissions', 'Compare agent performance']) {
  assert.ok(aboutMain.includes(heading), heading);
}
assert.doesNotMatch(about + product, /bed frame|Saturday dinner|monad-logo-mark\.png/i);
assert.equal((product.match(/data-handoff-timeline/g) || []).length, 3);
assert.doesNotMatch(about, /class="relay-track"|class="message-burst"|Illustrative · not measured time/);
for (const phrase of ['Shared audit trails and approval gates', 'who can access, edit, approve, and share']) {
  assert.equal(product.split(phrase).length - 1, 1, `Explain ${phrase} once, then demonstrate it`);
}
assert.equal(product.toLowerCase().split('two agents, two owners, one deliverable').length - 1, 1, 'Use the deck example heading only once');

for (const [pathname, html] of pages) {
  assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.envoi-agents\\.com${pathname}"`));
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `${pathname} must have one main heading`);
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, pathname === '/create-account/' ? 0 : 1, `${pathname} must identify its active tab`);
  if (pathname === '/product/') assert.doesNotMatch(html, /Rachel|>R</, `${pathname} must not retain the previous demo owner`);
  assert.match(html, /data-theme-control/);
  assert.match(html, /class="header-auth-link" href="(?:https:\/\/www\.envoi-agents\.com)?\/api\/auth\/workos\/sign-in\?returnTo=%2Fapp"[^>]*>Log in<\/a>/);
  assert.match(html, /class="header-auth-link header-auth-create" href="(?:https:\/\/www\.envoi-agents\.com)?\/api\/auth\/workos\/sign-up\?returnTo=%2Fapp"[^>]*>Create your account/);
  assert.match(html, /href="\/docs\/"/);
  assert.doesNotMatch(html, /href="\/team\/"/);
  const bootstrapIndex = html.indexOf('envoi-theme');
  assert.ok(bootstrapIndex >= 0 && bootstrapIndex < html.indexOf('<body'), `${pathname} must initialize theme before paint`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${pathname} has duplicate IDs`);
  for (const match of html.matchAll(/href="([^"{}]+)"/g)) {
    const url = new URL(match[1], `https://www.envoi-agents.com${pathname}`);
    if (url.origin !== 'https://www.envoi-agents.com') continue;
    if (['/api/auth/workos/sign-in', '/api/auth/workos/sign-up'].includes(url.pathname)) {
      assert.equal(url.hash, '', `Auth link cannot have a fragment: ${match[1]}`);
      assert.equal(url.searchParams.get('returnTo'), '/app', `Auth link must return to the workspace: ${match[1]}`);
      continue;
    }
    const target = pages.get(url.pathname);
    if (target) {
      if (url.hash) assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Broken section: ${pathname} → ${match[1]}`);
    } else {
      const destination = new URL(`../dist${url.pathname}${url.pathname.endsWith('/') ? 'index.html' : ''}`, import.meta.url);
      await access(destination);
      if (url.hash) assert.ok((await readFile(destination, 'utf8')).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Broken section: ${pathname} → ${match[1]}`);
    }
  }
}
console.log('About/Product separation, enterprise benefits, legacy redirect, themes, headings, IDs and links passed.');
