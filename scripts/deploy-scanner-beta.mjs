import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, requireSecretNames, secretInventory } from './promote-release.mjs';

export const SCANNER_BETA_DEPLOY_ARGS = Object.freeze(['deploy', '--config', 'scanner/wrangler.beta.jsonc']);

// N2-config-2: the scanner reads only ENVOI_SCANNER_TOKEN. Refuse to deploy while the beta scanner
// lacks it, or every scan would fail closed with 401.
export async function deployScannerBeta({ cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env, inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync } = {}) {
  await checkDeploymentConfiguration();
  requireSecretNames(inventory('--config', 'scanner/wrangler.beta.jsonc'), ['ENVOI_SCANNER_TOKEN']);
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, ...SCANNER_BETA_DEPLOY_ARGS], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('Beta scanner deployment failed');
  console.log('Beta scanner deployed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await deployScannerBeta(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
