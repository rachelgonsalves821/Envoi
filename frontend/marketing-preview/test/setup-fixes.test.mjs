import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const integrationRoot = fileURLToPath(new URL('../../../integrations/', import.meta.url));
const fixes = JSON.parse(readFileSync(new URL('../src/data/setup-fixes.json', import.meta.url), 'utf8'));
const listeningFixes = [
  'agent-not-listening',
  'listening-ended-after-reconnect',
  'background-receiving-failing',
  'background-receiving-unavailable'
];
const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8');
const codePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', 'test', 'fixtures'].includes(entry.name)) yield* sourceFiles(filename);
    if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts)$/.test(entry.name) && !/\.(?:test|spec|d)\./.test(entry.name)) yield filename;
  }
}

const literalCodes = text => [...text.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g)].map(match => match[1]);

test('every setup error emitted by the connector or returned during Dots approval has a public fix', () => {
  const required = new Set(['FEATURE_DISABLED', 'INSUFFICIENT_SCOPE', 'OAUTH_RECONSENT_REQUIRED']);
  for (const filename of sourceFiles(integrationRoot)) {
    const relative = path.relative(integrationRoot, filename).split(path.sep).join('/');
    const text = readFileSync(filename, 'utf8');
    if (!/ConnectorSetupError|OpenClawSetupError|ENROLLMENT_|CONNECTION_TEST_FAILED|SETUP_FAILED/.test(text)) continue;
    if (relative.startsWith('connector/')) {
      for (const code of literalCodes(text)) {
        if (code.startsWith('ENROLLMENT_') || ['CONNECTION_TEST_FAILED', 'SETUP_FAILED'].includes(code)) required.add(code);
      }
    }
    if (relative === 'openclaw/quick-connect-config.ts') {
      // The adapter forwards this union of error codes as ConnectorSetupError.
      const declaration = text.match(/\breadonly code:\s*([^=]+)=/);
      const codes = literalCodes(declaration?.[1] ?? '');
      assert.ok(codes.length, 'Cannot discover the OpenClaw setup error codes');
      for (const code of codes) required.add(code);
    }
    for (const match of text.matchAll(/\bnew\s+ConnectorSetupError\s*\(\s*([^,]+),/g)) {
      const argument = match[1].trim();
      if (relative === 'connector/enrollment-error.ts' && argument === 'code') continue;
      if (relative === 'openclaw/adapter.ts' && argument === 'error.code') continue;
      const codeBranches = argument.includes('?') ? argument.slice(argument.indexOf('?') + 1).split(':') : [argument];
      for (const branch of codeBranches) {
        const literal = branch.trim().match(/^['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]$/);
        assert.ok(literal, `Cannot discover the ConnectorSetupError code in ${relative}: ${argument}`);
        required.add(literal[1]);
      }
    }
  }

  const seen = new Set();
  for (const { code, title, appliesTo, whatHappened, whatToDo } of fixes) {
    if (!listeningFixes.includes(code)) assert.match(code, codePattern);
    assert.ok(!seen.has(code), `Duplicate setup fix: ${code}`);
    seen.add(code);
    assert.ok(Array.isArray(appliesTo) && appliesTo.length > 0, `${code} must name at least one platform`);
    for (const value of [title, whatHappened, whatToDo, ...appliesTo]) {
      assert.ok(typeof value === 'string' && value.trim(), `${code} has empty fix content`);
    }
  }
  assert.deepEqual([...required].filter(code => !seen.has(code)).sort(), [], 'Add the missing codes to setup-fixes.json');
});

test('background receiving fixes are present in the catalog and in llms.txt', () => {
  for (const code of listeningFixes) {
    assert.ok(fixes.some(fix => fix.code === code), code);
    assert.ok(llms.includes('https://www.envoi-agents.com/docs/fix/#' + code + ')'), code);
  }
});
