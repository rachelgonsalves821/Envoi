import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('built owner app contains no runtime schema compiler blocked by CSP', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script[^>]+src="(\/web\/assets\/[^\"]+\.js)"/)?.[1];
  expect(script).toBeTruthy();
  const bundle = readFileSync(new URL(`../../web${script!.slice('/web'.length)}`, import.meta.url), 'utf8');
  expect(bundle).not.toContain('new Function(');
  expect(bundle).not.toContain('Error compiling schema');
});
