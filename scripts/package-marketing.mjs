import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('frontend/marketing-preview/dist');
const destination = path.resolve('web/marketing');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

// Public setup docs are indexable too: every built docs/**/index.html page.
const docsPages = (await readdir(path.join(destination, 'docs'), { recursive: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
  .filter(entry => path.basename(entry) === 'index.html').map(entry => path.join('docs', entry)).sort();

for (const page of ['index.html', path.join('product', 'index.html'), ...docsPages]) {
  const file = path.join(destination, page);
  const html = await readFile(file, 'utf8');
  const previewDirective = '<meta name="robots" content="noindex, nofollow">';
  assert.equal(html.split(previewDirective).length - 1, 1, `${page}: expected one preview robots directive`);
  await writeFile(file, html.replace(previewDirective, '<meta name="robots" content="index, follow">'));
}

console.log(`Packaged public About, Product and ${docsPages.length} docs pages in web/marketing.`);
