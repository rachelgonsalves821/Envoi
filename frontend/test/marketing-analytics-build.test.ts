import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const marketingRoot = resolve(import.meta.dirname, '../../web/marketing');

function deliveredModules(html: string) {
  const visited = new Set<string>();
  const sources: string[] = [];
  const visit = (file: string) => {
    const path = resolve(marketingRoot, '_astro', file);
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    sources.push(source);
    for (const match of source.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) visit(match[1]);
  };
  for (const match of html.matchAll(/<script\b[^>]*src="\/_astro\/([^"/]+\.js)"/g)) visit(match[1]);
  return sources.join('\n');
}

describe('delivered marketing analytics', () => {
  it.each(['index.html', 'product/index.html'])('ships PostHog and marked auth links on %s', page => {
    const html = readFileSync(resolve(marketingRoot, page), 'utf8');
    expect(html).toContain('data-analytics-auth="sign-up"');
    expect(html).toContain('data-analytics-auth="sign-in"');
    const modules = deliveredModules(html);
    expect(modules).toContain('phc_nayMdaa954vNC4Dkx33k9Ui38kPQyp2xhn2YUYiFFfHH');
    expect(modules).toContain('https://us.i.posthog.com');
    expect(modules).toContain('sign_up_started');
    expect(modules).toContain('sign_in_started');
    expect(modules).toContain('$session_id');
  });
});
