import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, requireSecretNames, secretInventory } from './promote-release.mjs';

export const SCANNER_CONFIGS = Object.freeze({ staging: 'scanner/wrangler.jsonc', beta: 'scanner/wrangler.beta.jsonc' });

// N2-config-2: the scanner reads only ENVOI_SCANNER_TOKEN. Refuse to deploy to a scanner Worker that
// lacks it, or every scan would fail closed with 401.
export async function deployScanner(target, { cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env,
  inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync } = {}) {
  const config = SCANNER_CONFIGS[target];
  if (!config) throw new Error('Usage: node scripts/deploy-scanner.mjs staging|beta');
  await checkDeploymentConfiguration();
  requireSecretNames(inventory('--config', config), ['ENVOI_SCANNER_TOKEN']);
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, 'deploy', '--config', config], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error(`${target} scanner deployment failed`);
  console.log(`${target} scanner deployed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await deployScanner(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
