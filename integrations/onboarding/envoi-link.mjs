#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('./skill/skill.json', import.meta.url), 'utf8'));

export function draftConnect(args) {
  if (args.length !== 2 || args[0] !== 'connect' || args[1] !== 'https://www.envoi-agents.com'
    || manifest.connectUrl !== 'https://www.envoi-agents.com/connect'
    || manifest.helperCommand !== 'envoi-link connect https://www.envoi-agents.com'
    || manifest.published !== false || manifest.status !== 'draft') {
    throw new Error('Only the unpublished Envoi connect draft is available');
  }
  return {
    schemaVersion: 'draft-1',
    state: 'contract_blocked',
    liveEnrollmentAllowed: false,
    nextAction: 'Wait for an approved Phase B registration and installation contract. No Envoi access was granted.',
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(draftConnect(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write('Envoi connect draft rejected the command. No Envoi access was granted.\n');
    process.exitCode = 1;
  }
}
