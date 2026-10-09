import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS } from '../worker/runtime-config.js';

// Beta is verified only after its custom domain is bound. Staging keeps its
// separate workers.dev origin; never add beta workers.dev to edge admission.
export function validateReleaseTargets(config) {
  assert.equal(config.name, 'sinaloa', 'The old production Worker identity must stay unchanged');
  assert.equal(config.keep_vars, true, 'Preserve dashboard-managed runtime variables on deployment');
  assert.equal(config.env?.staging?.workers_dev, true, 'Staging must have an isolated workers.dev origin');
  assert.equal(config.env.staging.name ?? (config.name + '-staging'), 'sinaloa-staging', 'Staging must never deploy to the old production Worker');
  const beta = config.env?.beta;
  assert.ok(beta, 'Beta must deploy as a Worker separate from the old production Worker');
  assert.equal(beta.name ?? (config.name + '-beta'), 'sinaloa-beta', 'Beta must never deploy to the old production Worker');
  assert.equal(beta.workers_dev, false, 'Beta smoke requires its custom domain; disable beta workers.dev');
  assert.equal(beta.preview_urls ?? config.preview_urls ?? false, false, 'Beta must not expose workers.dev preview URLs');
  assert.deepEqual(beta.routes, [{ pattern: 'www.envoi-agents.com', custom_domain: true }, { pattern: 'beta.sinaloa-inbox.com', custom_domain: true }], 'Beta must retain the old beta host until redirects are verified');
  assert.equal(beta.vars?.SINALOA_PUBLIC_URL, 'https://www.envoi-agents.com');
  assert.ok(beta.vars?.SINALOA_CORS_ORIGIN?.split(',').includes(beta.vars.SINALOA_PUBLIC_URL));
  assert.equal(beta.vars?.SINALOA_EDGE_ALLOWED_HOSTS, 'www.envoi-agents.com,beta.sinaloa-inbox.com', 'Beta edge admission must remain limited to the two custom domains');
  assert.equal(beta.vars?.WORKOS_REDIRECT_URI, `${beta.vars.SINALOA_PUBLIC_URL}/api/auth/workos/callback`);
}

export async function checkDeploymentConfiguration() {
  const root = new URL('../', import.meta.url);
  const config = JSON.parse(await readFile(new URL('wrangler.jsonc', root), 'utf8'));
  validateReleaseTargets(config);
  assert.equal(config.keep_vars, true, 'Preserve dashboard-managed runtime variables on deployment');
  assert.equal(config.containers.length, 1, 'Beta routing supports exactly one container application');
  assert.equal(config.containers[0].max_instances, 1, 'Multiple instances require shared event/rate state and explicit routing; keep beta at one');
  assert.equal(config.containers[0].class_name, 'SinaloaContainer');
  assert.equal(config.containers[0].image, './Dockerfile.cloudflare');
  assert.ok(config.durable_objects.bindings.some(item => item.name === 'SINALOA_CONTAINER' && item.class_name === 'SinaloaContainer'));
  assert.ok(config.triggers.crons.includes('* * * * *'), 'In-process background jobs require the beta wake-up schedule');
  const staging = config.env?.staging;
  assert.ok(staging, 'A separately deployable staging environment is required before beta release');
  assert.equal(staging.workers_dev, true, 'Staging must have an isolated workers.dev origin');
  assert.equal(staging.containers?.length, 1, 'Staging requires one isolated container application');
  assert.equal(staging.containers[0].name, 'sinaloa-beta-staging');
  assert.equal(staging.containers[0].max_instances, 1);
  assert.equal(staging.containers[0].class_name, 'SinaloaContainer');
  assert.equal(staging.containers[0].image, './Dockerfile.cloudflare');
  assert.ok(staging.durable_objects?.bindings?.some(item => item.name === 'SINALOA_CONTAINER' && item.class_name === 'SinaloaContainer'), 'Staging requires its own container binding');
  assert.ok(staging.migrations?.some(item => item.new_sqlite_classes?.includes('SinaloaContainer')), 'Staging requires its own container migration');
  assert.ok(staging.triggers?.crons?.includes('* * * * *'), 'Staging background jobs require their own wake-up schedule');
  const beta = config.env?.beta;
  assert.ok(beta, 'Beta must deploy as a Worker separate from the old production Worker');
  assert.equal(beta.workers_dev, false, 'Beta smoke requires its custom domain; disable beta workers.dev');
  assert.deepEqual(beta.routes, [{ pattern: 'www.envoi-agents.com', custom_domain: true }, { pattern: 'beta.sinaloa-inbox.com', custom_domain: true }], 'Beta must retain the old beta host until redirects are verified');
  assert.ok(beta.triggers?.crons?.includes('* * * * *'), 'Beta background jobs require their own wake-up schedule');
  assert.equal(beta.containers?.length, 1, 'Beta requires one isolated container application');
  assert.equal(beta.containers[0].name, 'sinaloa-beta-release');
  assert.equal(beta.containers[0].max_instances, 1);
  assert.equal(beta.containers[0].class_name, 'SinaloaContainer');
  assert.equal(beta.containers[0].image, './Dockerfile.cloudflare');
  assert.equal(new Set([config.containers[0].name, staging.containers[0].name, beta.containers[0].name]).size, 3, 'Container application names must be distinct');
  assert.ok(beta.durable_objects?.bindings?.some(item => item.name === 'SINALOA_CONTAINER' && item.class_name === 'SinaloaContainer'), 'Beta requires its own container binding');
  assert.ok(beta.migrations?.some(item => item.new_sqlite_classes?.includes('SinaloaContainer')), 'Beta requires its own container migration');
  assert.equal(beta.vars?.SINALOA_PUBLIC_URL, 'https://www.envoi-agents.com');
  assert.ok(beta.vars?.SINALOA_CORS_ORIGIN?.split(',').includes(beta.vars.SINALOA_PUBLIC_URL));
  assert.equal(beta.vars?.SINALOA_EDGE_ALLOWED_HOSTS, 'www.envoi-agents.com,beta.sinaloa-inbox.com');
  assert.equal(beta.vars?.WORKOS_CLIENT_ID, 'client_01M3QMT1BN3HEBGE4VPEAQA0GT');
  assert.equal(beta.vars?.WORKOS_REDIRECT_URI, `${beta.vars.SINALOA_PUBLIC_URL}/api/auth/workos/callback`);
  assert.equal(beta.vars?.SINALOA_DB_SSL_MODE, 'verify-full');
  assert.equal(beta.vars?.SINALOA_S3_ENDPOINT, 'https://54a5d6c680bd813fa60f8e088b098b8d.r2.cloudflarestorage.com');
  assert.equal(beta.vars?.SINALOA_S3_BUCKET, 'sinaloa-beta');
  assert.equal(beta.vars?.SINALOA_MALWARE_SCANNER_URL, 'https://sinaloa-scanner-beta.rachelgonsalves821.workers.dev/scan', 'Beta must use the dedicated scanner');
  const betaScanner = JSON.parse(await readFile(new URL('scanner/wrangler.beta.jsonc', root), 'utf8'));
  assert.equal(betaScanner.name, 'sinaloa-scanner-beta');
  assert.equal(betaScanner.containers?.[0]?.name, 'sinaloa-clamav-beta');
  assert.equal(betaScanner.containers?.[0]?.class_name, 'ClamAVContainer');
  assert.ok(betaScanner.triggers?.crons?.includes('*/5 * * * *'));
  assert.equal(new Set(CONTAINER_ENV_KEYS).size, CONTAINER_ENV_KEYS.length, 'Runtime allowlist contains duplicates');
  assert.equal(CONTAINER_DEFAULTS.ENVOI_PORT, '8787');
  const docker = await readFile(new URL('Dockerfile.cloudflare', root), 'utf8');
  assert.match(docker, /FROM node:22-alpine/);
  assert.match(docker, /EXPOSE 8787/);
  assert.match(docker, /COPY --chown=node:node protocol \.\/protocol/, 'Server startup imports the protocol schema; include it in the image');
  assert.equal((await readFile(new URL('.node-version', root), 'utf8')).trim(), '22');
  const scripts = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).scripts;
  assert.match(scripts['cf:deploy:staging'], /wrangler deploy --env staging/);
  assert.equal(scripts['cf:deploy:beta'], 'node scripts/deploy-beta-build.mjs');
  for (const command of scripts['cf:check'].split('&&').map(item => item.trim()).filter(item => item.includes('wrangler deploy'))) {
    assert.match(command, /(?: --env (?:staging|beta)| --config scanner\/wrangler\.beta\.jsonc)$/, 'CI must not target the old production Worker');
  }
  assert.doesNotMatch(scripts['cf:deploy'], /wrangler deploy(?!.*--env)/, 'The unqualified deploy command must not target the old production Worker');
  console.log(`Deployment configuration checked: ${fileURLToPath(root)}`);

}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await checkDeploymentConfiguration();
