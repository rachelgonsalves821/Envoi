// Gate B-local preflight (runbook §2). Read-only GETs against the local gate.
//   NODE_EXTRA_CA_CERTS=<gate dir>\localhost.pem node scripts/gate-b-local/preflight.mjs [--gate-dir <dir>] [--origin https://localhost:8443]
// The expected SHA is <gate dir>/gate-sha.txt, written by start-server.ps1.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const gateDir = arg('--gate-dir', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'envoi-gate-b-local'));
const origin = arg('--origin', 'https://localhost:8443');
const gateSha = readFileSync(join(gateDir, 'gate-sha.txt'), 'utf8').trim();
const repoSkill = readFileSync(fileURLToPath(new URL('../../integrations/onboarding/skill/SKILL.md', import.meta.url)));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
const get = async (route) => { const response = await fetch(origin + route); return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }; };

const health = await get('/health');
const healthJson = JSON.parse(health.body);
check('/health releaseSha is the gate SHA', health.status === 200 && healthJson.releaseSha === gateSha, `${health.status} releaseSha=${healthJson.releaseSha} mode=${healthJson.mode} service=${healthJson.service}`);

const routes = await get('/api/onboarding/routes');
const routesJson = JSON.parse(routes.body);
const offered = (value) => (value || []).filter((item) => item.available === true).map((item) => item.connectionRoute ?? item.deliveryMode);
const routeIds = offered(routesJson.connectionRoutes ?? routesJson.routes);
const modeIds = offered(routesJson.deliveryModes ?? routesJson.modes);
check('routes offer exactly local_helper and envoi_link', routes.status === 200 && JSON.stringify(routeIds) === '["local_helper"]' && JSON.stringify(modeIds) === '["envoi_link"]', `routes=${JSON.stringify(routeIds)} modes=${JSON.stringify(modeIds)}`);

const skill = await get('/connect/skill.json');
const skillJson = JSON.parse(skill.body);
check('skill.json lists the same', skill.status === 200 && JSON.stringify(skillJson.offeredConnectionRoutes) === JSON.stringify(routeIds) && JSON.stringify(skillJson.offeredDeliveryModes) === JSON.stringify(modeIds), `offeredConnectionRoutes=${JSON.stringify(skillJson.offeredConnectionRoutes)} offeredDeliveryModes=${JSON.stringify(skillJson.offeredDeliveryModes)}`);

const skillMd = await get('/connect/SKILL.md');
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
check('SKILL.md byte-identical to the repository', skillMd.status === 200 && Buffer.compare(skillMd.body, repoSkill) === 0, `served=${sha(skillMd.body)} repo=${sha(repoSkill)}`);

const status = await get('/api/agent/status');
check('agent status refuses without a credential', status.status === 401, `${status.status}`);

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${result.detail})`);
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
