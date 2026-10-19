#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createHelper } from './helper/state.mjs';
import { loadContract, failureOutput } from './helper/output.mjs';
import { validateOrigin } from './helper/transport.mjs';
export { createHelper, connectionFailure } from './helper/state.mjs';

// Retained for callers inspecting the old unpublished draft API. The executable
// entry below uses runCli; bundled runtime integration injects adopt/preflight.
export function draftConnect(args) {
  const manifest = JSON.parse(readFileSync(new URL('./skill/skill.json', import.meta.url), 'utf8'));
  if (args.length !== 2 || args[0] !== 'connect' || args[1] !== 'https://www.envoi-agents.com'
    || manifest.published !== false || manifest.status !== 'draft') throw new Error('Only the unpublished Envoi connect draft is available');
  return { schemaVersion: 'draft-1', state: 'contract_blocked', liveEnrollmentAllowed: false,
    nextAction: 'Wait for the Phase B server, the hosted Phase A gate, and an offered connection route. The planned local flow requires explicit human confirmation of the approver, workspace, agent and permissions before activation. No Envoi access was granted.' };
}

/** Returns one safe projection. It never writes raw diagnostics or credentials. */
export async function runCli(args, dependencies = {}) {
  let contract;
  try {
    contract = await loadContract(dependencies.contract);
    const [command, suppliedOrigin, ...flags] = args;
    if (!['connect', 'resume', 'status', 'doctor'].includes(command) || !suppliedOrigin) throw new Error('INVALID_COMMAND');
    let runtimeType = dependencies.runtime?.type ?? 'hermes';
    let showCode = false, fresh = false;
    for (let index = 0; index < flags.length; index++) {
      if (flags[index] === '--runtime' && ['hermes', 'openclaw'].includes(flags[index + 1])) runtimeType = flags[++index];
      else if (flags[index] === '--show-code') showCode = true;
      else if (flags[index] === '--new' && command === 'connect') fresh = true;
      else throw new Error('INVALID_COMMAND');
    }
    const origin = validateOrigin(suppliedOrigin);
    if (typeof dependencies.adopt !== 'function' && !dependencies.store) return failureOutput(contract);
    const runtime = { type: runtimeType, version: dependencies.runtime?.version ?? 'unknown' };
    const directory = dependencies.directory ?? join(homedir(), '.envoi', 'onboarding', createHash('sha256').update(`${origin}:${runtime.type}`).digest('hex').slice(0, 24));
    const helper = await createHelper({ ...dependencies, contract, origin, runtime, directory });
    return await helper[command]({ showCode, fresh });
  } catch { return contract ? failureOutput(contract) : { schemaVersion: '1', state: 'needs_help', nextAction: 'Use the reviewed private helper build. Preserve any saved connection state.' }; }
}

if ((typeof __ENVOI_LINK_BUNDLED__ === 'undefined' || !__ENVOI_LINK_BUNDLED__) && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state === 'needs_help') process.exitCode = 1;
}
