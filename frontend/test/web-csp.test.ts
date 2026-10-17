import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('built owner app contains no runtime schema compiler blocked by CSP', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  expect(html).not.toContain('new Function(');
  expect(html).not.toContain('Error compiling schema');
});
