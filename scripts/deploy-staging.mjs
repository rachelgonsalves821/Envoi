import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, requireStagingSecretNames, secretInventory } from './promote-release.mjs';

export function stagingDeployArgs({ sha, clean }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Staging deploy requires a full lowercase 40-hex Git commit SHA');
  if (!clean) throw new Error('Staging deploy requires a clean worktree, including untracked files, so the release SHA matches the deployed source');
  // N2-config-2: only ENVOI_RELEASE_SHA. A kept dashboard SINALOA_RELEASE_SHA is no longer read.
  return ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${sha}`];
}

export async function deployStaging({ cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env,
  inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync,
  readGit = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } = {}) {
  await checkDeploymentConfiguration();
  const sha = readGit('rev-parse', 'HEAD');
  const args = stagingDeployArgs({ sha, clean: readGit('status', '--porcelain', '--untracked-files=all').length === 0 });
  requireStagingSecretNames(inventory);
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, ...args], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('Staging deployment failed');
  console.log(`Staging Worker deployed from ${sha}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await deployStaging(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
