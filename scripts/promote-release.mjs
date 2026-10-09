import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';

export const RELEASE_ACCOUNT_ID = '54a5d6c680bd813fa60f8e088b098b8d';
export const APP_SECRET_NAMES = Object.freeze([
  'DATABASE_URL', 'WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD',
  'ENVOI_BETA_INVITED_EMAILS', 'ENVOI_DATA_ENCRYPTION_KEY',
  'ENVOI_POLICY_SIGNING_KEY', 'ENVOI_S3_ACCESS_KEY_ID',
  'ENVOI_S3_SECRET_ACCESS_KEY', 'ENVOI_MALWARE_SCANNER_TOKEN'
]);

export function requireSecretNames(inventory, required = APP_SECRET_NAMES) {
  if (!Array.isArray(inventory)) throw new Error('Worker secret inventory must be a JSON array');
  const names = new Set(inventory.filter(item => item?.type === 'secret_text').map(item => item.name));
  const hasSecret = name => names.has(name) || (name.startsWith('ENVOI_') && names.has(`SINALOA_${name.slice('ENVOI_'.length)}`));
  const missing = required.filter(name => !hasSecret(name)
    && !(name === 'ENVOI_POLICY_SIGNING_KEY' && hasSecret('ENVOI_POLICY_SIGNING_KEYS')));
  if (missing.length) throw new Error(`Missing encrypted runtime secrets: ${missing.join(', ')}`);
}

export function promotionPlan({ target, sha, headSha, mainSha, clean, descendedFromMain, deploy = false }) {
  if (!['staging', 'beta'].includes(target)) throw new Error('Choose the explicit staging or beta release target');
  for (const value of [sha, headSha, mainSha]) {
    if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Release and Git references must use full lowercase 40-hex SHAs');
  }
  if (!clean) throw new Error('Release worktree must be clean, including untracked files');
  if (headSha !== sha) throw new Error('Recorded release SHA must exactly match checked-out HEAD');
  if (!descendedFromMain) throw new Error('Release candidate must descend from fetched origin/main');
  if (deploy && sha !== mainSha) throw new Error('Live promotion requires HEAD to equal fetched origin/main; merge and fetch the reviewed fixes first');
  return {
    target, sha, accountId: RELEASE_ACCOUNT_ID, deploy,
    args: ['deploy', '--env', target, '--var', `ENVOI_RELEASE_SHA:${sha}`, '--var', `SINALOA_RELEASE_SHA:${sha}`,
      ...(deploy ? [] : ['--dry-run', '--containers-rollout=none'])]
  };
}

export async function promoteRelease(args, { cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env } = {}) {
  const [target, sha, ...flags] = args;
  if (flags.length > 1 || flags.some(flag => flag !== '--deploy')) {
    throw new Error('Usage: node scripts/promote-release.mjs staging|beta FULL_SHA [--deploy]');
  }
  const git = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (flags.includes('--deploy')) git('fetch', 'origin', 'main');
  const headSha = git('rev-parse', 'HEAD');
  const mainSha = git('rev-parse', 'origin/main');
  const plan = promotionPlan({ target, sha, headSha, mainSha,
    clean: git('status', '--porcelain').length === 0,
    descendedFromMain: spawnSync('git', ['merge-base', '--is-ancestor', mainSha, headSha], { cwd }).status === 0,
    deploy: flags.includes('--deploy') });
  await checkDeploymentConfiguration();
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const workerEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID };
  if (plan.deploy) {
    // Secret list contains names/types only. Values are never fetched or logged.
    const inventory = (...argv) => {
      const result = spawnSync(process.execPath, [wrangler, 'secret', 'list', ...argv], {
        cwd, env: workerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.error || result.status !== 0) throw new Error('Could not verify encrypted secret names in the intended Cloudflare account');
      try { return JSON.parse(result.stdout); }
      catch { throw new Error('Worker secret inventory was not valid JSON'); }
    };
    requireSecretNames(inventory('--env', target));
    if (target === 'beta') {
      requireSecretNames(inventory('--config', 'scanner/wrangler.beta.jsonc'), ['ENVOI_SCANNER_TOKEN']);
    }
  }
  console.log(JSON.stringify({ target: plan.target, releaseSha: plan.sha, accountId: plan.accountId,
    action: plan.deploy ? 'deploy' : 'dry-run',
    scope: 'Git identity, target configuration and (for deploy) secret names; live provider and product acceptance remain separate gates.' }));
  const result = spawnSync(process.execPath, [wrangler, ...plan.args], { cwd, env: workerEnv, stdio: 'inherit' });
  if (result.error) throw new Error('Unable to start Wrangler');
  if (result.status !== 0) throw new Error(`Wrangler ${plan.deploy ? 'deployment' : 'dry-run'} failed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await promoteRelease(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
