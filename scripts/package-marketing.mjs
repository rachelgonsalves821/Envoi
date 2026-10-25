import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('frontend/marketing-preview/dist');
const destination = path.resolve('web/marketing');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

for (const page of ['index.html', path.join('product', 'index.html')]) {
  const file = path.join(destination, page);
  const html = await readFile(file, 'utf8');
  const previewDirective = '<meta name="robots" content="noindex, nofollow">';
  assert.equal(html.split(previewDirective).length - 1, 1, `${page}: expected one preview robots directive`);
  await writeFile(file, html.replace(previewDirective, '<meta name="robots" content="index, follow">'));
}

console.log('Packaged public About and Product pages in web/marketing.');
