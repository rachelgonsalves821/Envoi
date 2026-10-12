import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Run with: node --test integrations/onboarding/test/skill-contract.test.mjs
// These are static checks for the Phase B draft, not hosted onboarding evidence.
// The override lets separate worktrees validate the proposed files before integration.
const skillDirectory = process.env.ENVOI_ONBOARDING_SKILL_DIR
  ? pathToFileURL(resolve(process.env.ENVOI_ONBOARDING_SKILL_DIR) + sep)
  : new URL('../skill/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, skillDirectory), 'utf8');
}

test('the draft package includes readable skill, heartbeat, and JSON metadata', async () => {
  const [skill, heartbeat, json] = await Promise.all([
    source('SKILL.md'),
    source('HEARTBEAT.md'),
    source('skill.json'),
  ]);
  const metadata = JSON.parse(json);
  assert.equal(typeof metadata, 'object');
  assert.ok(metadata && !Array.isArray(metadata));
  for (const [name, content] of [['SKILL.md', skill], ['HEARTBEAT.md', heartbeat]]) {
    assert.ok(content.trim().length > 100, `${name} must contain useful instructions`);
    assert.doesNotMatch(content, /sinaloa/i, `${name} must use the Envoi product name`);
  }
  assert.doesNotMatch(json, /sinaloa/i);
  assert.equal(metadata.name, 'envoi-agent-connect');
  assert.equal(metadata.status, 'draft');
  assert.equal(metadata.published, false);
  assert.equal(metadata.skill, 'SKILL.md');
  assert.equal(metadata.heartbeat, 'HEARTBEAT.md');
  assert.equal(metadata.connectUrl, 'https://www.envoi-agents.com/connect');
  assert.equal(metadata.helperCommand, 'envoi-link connect https://www.envoi-agents.com');
  assert.ok(Array.isArray(metadata.requires));
  for (const requirement of ['trusted-envoi-link-helper', 'authenticated-human-claim', 'verified-runtime-capabilities']) {
    assert.ok(metadata.requires.includes(requirement), `missing ${requirement}`);
  }
});

test('the skill routes agent setup through the trusted helper and human claim', async () => {
  const skill = await source('SKILL.md');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, 'SKILL.md needs Agent Skills YAML frontmatter');
  assert.match(frontmatter[1], /^name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/m);
  assert.match(frontmatter[1], /^description:\s*\S.+$/m);
  assert.match(frontmatter[1], /^name:\s*envoi-agent-connect\s*$/m);
  assert.match(skill, /envoi-link connect https:\/\/www\.envoi-agents\.com/);
  assert.match(skill, /claim/i);
  assert.match(skill, /verif(?:y|ication)/i);
  assert.match(skill, /human|owner/i);
  assert.match(skill, /approv/i);
  assert.match(skill, /code/i);
  assert.doesNotMatch(skill, /(?:curl|Invoke-WebRequest|wget)\s+[^\n]*(?:agent-registrations|token|refresh)/i,
    'the model must not perform secret-bearing protocol calls');
});

test('neither model-facing file contains a credential or asks the model to copy one', async () => {
  for (const name of ['SKILL.md', 'HEARTBEAT.md']) {
    const content = await source(name);
    assert.doesNotMatch(content, /(?:envoi|sinaloa)_(?:agent|refresh|bootstrap|probe)_[A-Za-z0-9_-]{20,}/i,
      `${name} must not embed a credential`);
    assert.doesNotMatch(content, /(?:paste|send|copy|print|show)\s+(?:the\s+|your\s+|an?\s+)?(?:access|refresh|bootstrap|operational|private)\s+(?:key|token|secret)\s+(?:into|to|in)\s+(?:chat|the\s+model|a\s+prompt)/i,
      `${name} must not ask for a credential in model context`);
    assert.doesNotMatch(content, /(?:Bearer|Authorization:)\s+[A-Za-z0-9_.-]{20,}/i,
      `${name} must not embed a bearer credential`);
  }
});

test('the heartbeat distinguishes healthy live link, recovery, and scheduled fallback', async () => {
  const heartbeat = await source('HEARTBEAT.md');
  for (const command of ['envoi-link status', 'envoi-link recover', 'envoi-link check']) {
    assert.ok(heartbeat.includes(command), `missing ${command}`);
  }
  assert.match(heartbeat, /healthy/i);
  assert.match(heartbeat, /degraded|disconnect/i);
  assert.match(heartbeat, /schedul|poll|heartbeat/i);
  assert.match(heartbeat, /if|when/i);
  assert.doesNotMatch(heartbeat, /(?:guaranteed|always)\s+(?:automatic|autonomous|instant|real.time)\s+(?:wake|delivery|processing)/i,
    'the skill cannot guarantee a runtime capability before hosted proof');
});

test('package does not claim Phase B or live wake has already passed', async () => {
  const contents = await Promise.all(['SKILL.md', 'HEARTBEAT.md', 'README.md'].map(source));
  const text = contents.join('\n');
  assert.match(contents[0], /draft|planned|not yet|not implemented|prototype/i,
    'the agent-facing skill must disclose its pre-acceptance state');
  assert.match(contents[2], /draft|unpublished|not yet|not implemented|prototype/i,
    'the package README must disclose its unpublished state');
  assert.doesNotMatch(text, /(?:Hermes|OpenClaw|Muse|Instinct)\s+(?:has|is)\s+(?:already\s+)?(?:proven|verified|live|automatically available)/i);
  assert.doesNotMatch(text, /(?:all|any)\s+agents?\s+(?:can|will)\s+(?:be\s+)?(?:woken|wake|respond)\s+(?:automatically|unattended)/i);
});

test('proposed helper examples expose only allowlisted model-visible fields', async () => {
  const document = await source('HELPER-OUTPUT-EXAMPLES.md');
  assert.match(document, /not an approved server or helper contract/i);
  const examples = [...document.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 6);
  const allowed = new Set([
    'schemaVersion', 'state', 'claimUrl', 'verificationCode', 'expiresInSeconds',
    'nextAction', 'agentAddress', 'deliveryMode', 'reachability', 'permissionSummary',
  ]);
  for (const example of examples) {
    assert.equal(example.schemaVersion, 'draft-1');
    for (const key of Object.keys(example)) assert.ok(allowed.has(key), `model output field ${key} is not allowlisted`);
    assert.doesNotMatch(JSON.stringify(example), /(?:access|refresh|bootstrap|activation|private)(?:Token|Key|Code)|Authorization|Bearer/i);
  }
  assert.equal(examples.filter((example) => 'verificationCode' in example).length, 1);
  assert.deepEqual(examples.map((example) => example.state), [
    'pending_approval', 'connected', 'connected', 'paused', 'needs_reconnect', 'revoked',
  ]);
});
