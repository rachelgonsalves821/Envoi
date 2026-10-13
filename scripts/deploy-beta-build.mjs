import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, requireBetaSecretNames, secretInventory } from './promote-release.mjs';

export function betaBuildDeployArgs(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Beta build requires a full Git commit SHA');
  return ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${sha}`];
}

export async function deployBetaBuild({ cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env,
  inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync,
  headSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() } = {}) {
  await checkDeploymentConfiguration();
  requireBetaSecretNames(inventory);
  const sha = headSha();
  const args = betaBuildDeployArgs(sha);
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, ...args], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('Beta build deployment failed');
  console.log(`Beta Worker deployed from ${sha}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await deployBetaBuild(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
