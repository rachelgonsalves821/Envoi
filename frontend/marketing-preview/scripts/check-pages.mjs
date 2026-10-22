import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const pages = new Map([
  ['/', await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')],
  ['/product/', await readFile(new URL('../dist/product/index.html', import.meta.url), 'utf8')]
]);
const about = pages.get('/');
const product = pages.get('/product/');
assert.match(about, /data-page="about"/);
assert.match(product, /data-page="product"/);
assert.match(about, /id="how-it-works"/);
assert.match(about, /id="collaboration"/);
assert.doesNotMatch(about, /data-thread|id="your-view"|id="oversight"/);
assert.match(product, /data-thread/);
assert.match(product, /id="your-view"/);
assert.doesNotMatch(product, /id="oversight"|Set the terms|An agreement, with the context attached/);
assert.match(product, /Native messaging between agents with human oversight\./);
assert.doesNotMatch(product, /id="how-it-works"|id="collaboration"/);
const aboutMain = about.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
assert.doesNotMatch(aboutMain, /Native messaging|scoped file access|approval gates|Shared audit trails|Marketplace policy|data-inbox-row|comparison-chart|plain-columns/i);
assert.match(aboutMain, /Envoi is building infrastructure that allows independently owned agents to work together, regardless of where they run\./);
const aboutWords = aboutMain.replace(/<[^>]*>/g, ' ').trim().split(/\s+/);
assert.ok(aboutWords.length < 200, `About must stay concise, received ${aboutWords.length} words`);
assert.match(about, /data-collaboration-flow/);
assert.doesNotMatch(product, /data-collaboration-flow/);
assert.doesNotMatch(about, /class="relay-track"|class="message-burst"|Illustrative · not measured time/);
for (const phrase of ['Shared audit trails and approval gates', 'who can access, edit, approve, and share']) {
  assert.equal(product.split(phrase).length - 1, 1, `Explain ${phrase} once, then demonstrate it`);
}
assert.equal(product.toLowerCase().split('two agents, two owners, one deliverable').length - 1, 1, 'Use the deck example heading only once');

for (const [pathname, html] of pages) {
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `${pathname} must have one main heading`);
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1, `${pathname} must identify its active tab`);
  assert.doesNotMatch(html, /Rachel|>R</, `${pathname} must not retain the previous demo owner`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${pathname} has duplicate IDs`);
  for (const match of html.matchAll(/href="([^"{}]+)"/g)) {
    if (/^https?:\/\//.test(match[1])) continue;
    const url = new URL(match[1], `https://envoi-agents.com${pathname}`);
    if (url.origin !== 'https://envoi-agents.com') continue;
    const target = pages.get(url.pathname);
    if (target) {
      if (url.hash) assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Broken section: ${pathname} → ${match[1]}`);
    } else {
      assert.equal(url.hash, '', `Unknown page: ${match[1]}`);
      await access(new URL(`../dist${url.pathname}`, import.meta.url));
    }
  }
}
console.log('About/Product route separation, headings, IDs and internal links passed.');
