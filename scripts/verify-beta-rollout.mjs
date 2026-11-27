import { setTimeout as delay } from 'node:timers/promises';
import { smokeDeployment } from './smoke-deployment.mjs';

const betaOrigin = 'https://www.envoi-agents.com/';

// Wrangler reports that the Worker was published before its single Container has
// necessarily started with the matching image and runtime settings.
export async function waitForBetaDeployment(sha, { fetchImpl = fetch, sleep = delay,
  smoke = smokeDeployment, attempts = 96, log = console.log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let converged = false;
    try {
      const [health, ready] = await Promise.all(['/health', '/ready'].map(async pathname => {
        const response = await fetchImpl(new URL(pathname, betaOrigin), {
          redirect: 'error', signal: AbortSignal.timeout(10_000)
        });
        return response.ok ? response.json().catch(() => null) : null;
      }));
      converged = health?.releaseSha === sha && ready?.releaseSha === sha && ready?.ready === true
        && health?.configurationValidated === true && ready?.configurationValidated === true;
    } catch { /* A restarting Container may temporarily refuse requests. */ }
    if (converged) {
      await smoke(betaOrigin, sha, { fetchImpl, log });
      return;
    }
    if (attempt === attempts) break;
    if (attempt === 1 || attempt % 12 === 0) log(`Waiting for beta Worker and Container to serve ${sha.slice(0, 7)} (${attempt}/${attempts})`);
    await sleep(5_000);
  }
  throw new Error(`Beta Worker and Container did not confirm release ${sha} within the rollout window`);
}
