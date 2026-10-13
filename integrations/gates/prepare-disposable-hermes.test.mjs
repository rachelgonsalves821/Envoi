import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./prepare-disposable-hermes.ps1', import.meta.url), 'utf8');
const argumentLiteral = source.match(/\$chatArguments\s*=\s*@\(([^\r\n]*)\)/)?.[1];
assert.ok(argumentLiteral, 'The bounded model-turn arguments must remain inspectable');
const argumentsList = [...argumentLiteral.matchAll(/'([^']*)'/g)].map(match => match[1]);

test('provider defaults to the disposable profile rather than a specific vendor', () => {
  assert.match(source, /\[string\]\$Provider\s*,/);
  assert.ok(!argumentsList.includes('--provider'));
  assert.match(source, /if\s*\(\$Provider\)\s*\{\s*\$chatArguments\s*\+=\s*@\('--provider',\s*\$Provider\)/);
});

test('text-only model check excludes optional toolsets and stays bounded', () => {
  assert.equal(argumentsList[argumentsList.indexOf('--toolsets') + 1], 'context_engine');
  assert.equal(argumentsList[argumentsList.indexOf('--max-turns') + 1], '3');
  assert.equal(argumentsList[argumentsList.indexOf('--run-budget') + 1], '120');
  assert.ok(argumentsList.includes('--ignore-rules'));
  assert.ok(!argumentsList.includes('--safe-mode'));
  assert.match(source, /&\s*\$hermesCli\s*@chatArguments/);
});

test('model override is invocation-only and defaults to the disposable profile', () => {
  assert.match(source, /\[string\]\$Model\s*,/);
  assert.ok(!argumentsList.includes('--model'));
  assert.match(source, /if\s*\(\$Model\)\s*\{\s*\$chatArguments\s*\+=\s*@\('--model',\s*\$Model\)/);
  assert.ok(!/Set-Content|Out-File|config\.yaml/.test(source));
});

test('helper scopes and restores the profile without starting enrollment or installing extras', () => {
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$HermesHome\s*\)/);
  assert.match(source, /IsPathRooted\(\$HermesHome\)/);
  assert.ok(!source.includes('C:\\Users\\Rachel'));
  assert.match(source, /\$env:HERMES_HOME\s*=\s*\$profile/);
  assert.match(source, /finally\s*\{\s*\$env:HERMES_HOME\s*=\s*\$previousHome/);
  assert.ok(!/pm install|prepare-runtime|agent-registration|secret put/.test(source));
});
