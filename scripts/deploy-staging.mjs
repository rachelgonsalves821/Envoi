import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, requireStagingSecretNames, secretInventory } from './promote-release.mjs';

export function stagingDeployArgs({ sha, clean, dryRun = false }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Staging deploy requires a full lowercase 40-hex Git commit SHA');
  if (!clean) throw new Error('Staging deploy requires a clean worktree, including untracked files, so the release SHA matches the deployed source');
  // N2-config-2: only ENVOI_RELEASE_SHA. A kept dashboard SINALOA_RELEASE_SHA is no longer read.
  return ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${sha}`,
    ...(dryRun ? ['--dry-run', '--containers-rollout=none'] : [])];
}

export async function deployStaging({ cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env, dryRun = false,
  inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync,
  readGit = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } = {}) {
  await checkDeploymentConfiguration();
  const sha = readGit('rev-parse', 'HEAD');
  const args = stagingDeployArgs({ sha, clean: readGit('status', '--porcelain', '--untracked-files=all').length === 0, dryRun });
  if (!dryRun) requireStagingSecretNames(inventory);
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, ...args], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  const action = dryRun ? 'dry run' : 'deployment';
  if (result.error || result.status !== 0) throw new Error(`Staging ${action} failed`);
  console.log(`Staging ${action} completed for ${sha}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
      throw new Error('Usage: npm run cf:deploy:staging -- [--dry-run]');
    }
    await deployStaging({ dryRun: args.length === 1 });
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
