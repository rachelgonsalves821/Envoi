import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateReleaseTargets } from '../scripts/check-deployment.mjs';
import { smokeDeployment } from '../scripts/smoke-deployment.mjs';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('release configuration permits staging workers.dev and only the beta custom domain', () => {
  assert.doesNotThrow(() => validateReleaseTargets(config));
});

for (const [description, mutate] of [
  ['deploying staging to the old production Worker', candidate => { candidate.env.staging.name = 'sinaloa'; }],
  ['deploying beta to the old production Worker', candidate => { candidate.env.beta.name = 'sinaloa'; }],
  ['enabling beta preview URLs', candidate => { candidate.env.beta.preview_urls = true; }],
  ['re-enabling beta workers.dev', candidate => { candidate.env.beta.workers_dev = true; }],
  ['disabling staging workers.dev', candidate => { candidate.env.staging.workers_dev = false; }],
  ['discarding dashboard runtime variables', candidate => { candidate.keep_vars = false; }],
  ['changing the old production Worker identity', candidate => { candidate.name = 'sinaloa-beta'; }],
  ['binding beta to the old production hostname', candidate => { candidate.env.beta.routes = [{ pattern: 'sinaloa-inbox.com', custom_domain: true }]; }],
  ['adding a beta workers.dev route', candidate => { candidate.env.beta.routes.push({ pattern: 'sinaloa-beta.rachelgonsalves821.workers.dev' }); }],
  ['broadening beta edge hostname admission', candidate => { candidate.env.beta.vars.SINALOA_EDGE_ALLOWED_HOSTS += ',sinaloa-beta.rachelgonsalves821.workers.dev'; }],
  ['moving beta browser auth to workers.dev', candidate => { candidate.env.beta.vars.SINALOA_PUBLIC_URL = 'https://sinaloa-beta.rachelgonsalves821.workers.dev'; }],
  ['using the staging callback for beta', candidate => { candidate.env.beta.vars.WORKOS_REDIRECT_URI = 'https://sinaloa-staging.rachelgonsalves821.workers.dev/api/auth/workos/callback'; }],
]) {
  test(`release target validation rejects ${description}`, () => {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.throws(() => validateReleaseTargets(candidate), assert.AssertionError);
  });
}

const releaseSha = '0123456789abcdef0123456789abcdef01234567';
function smokeResponses(overrides = {}) {
  return async url => {
    const pathname = url.pathname;
    if (pathname === '/health') return Response.json({ service: 'sinaloa', mode: 'production', configurationValidated: true, releaseSha, ...overrides.health });
    if (pathname === '/ready') return Response.json({ ready: true, mode: 'production', configurationValidated: true, releaseSha, ...overrides.ready });
    if (pathname === '/api/auth/config') return Response.json({ enabled: true });
    return new Response('<html><script src="/app.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  };
}

test('release smoke confirms the recorded SHA on health and readiness', async () => {
  await assert.doesNotReject(() => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses(), log() {} }));
});

for (const endpoint of ['health', 'ready']) {
  for (const [description, returnedSha] of [['another release', 'f'.repeat(40)], ['missing release evidence', undefined]]) {
    test(`release smoke rejects ${description} from /${endpoint}`, async () => {
      await assert.rejects(
        () => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses({ [endpoint]: { releaseSha: returnedSha } }), log() {} }),
        new RegExp(`/${endpoint} did not confirm the expected release SHA`)
      );
    });
  }
}

test('invalid release SHA fails before contacting the deployment', async () => {
  await assert.rejects(
    () => smokeDeployment('https://www.envoi-agents.com/', 'short-sha', { fetchImpl() { assert.fail('No request should be made'); }, log() {} }),
    /full 40-hex release SHA/
  );
});

test('read-only smoke remains compatible when no expected SHA is supplied', async () => {
  await assert.doesNotReject(() => smokeDeployment('https://www.envoi-agents.com/', undefined, { fetchImpl: smokeResponses({ health: { releaseSha: undefined }, ready: { releaseSha: undefined } }), log() {} }));
});
