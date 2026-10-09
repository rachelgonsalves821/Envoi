import { Container, getContainer } from '@cloudflare/containers';
import { env as runtimeEnv } from 'cloudflare:workers';
import {
  createForwardedRequest,
  isAllowedHostname,
  releaseIsStale,
  selectEnvironment,
  serviceUnavailableResponse,
  withNoStoreHeaders
} from './router.js';

const CONTAINER_NAME = 'sinaloa-beta-primary';
const CONTAINER_PORT = 8787;

import { CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS } from './runtime-config.js';

export class SinaloaContainer extends Container {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = '5m';
  pingEndpoint = 'localhost/ready';
  enableInternet = true;
  envVars = selectEnvironment(runtimeEnv, CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS);

  // Only an object running the Worker version that carries this SHA may restart the
  // container; an older object would start it again with the same stale variables.
  // At most one restart per release, so a container that still disagrees cannot flap.
  async restartForRelease(expectedSha) {
    if (this.envVars.ENVOI_RELEASE_SHA !== expectedSha) return false;
    if (await this.ctx.storage.get('restartedForRelease') === expectedSha) return false;
    await this.ctx.storage.put('restartedForRelease', expectedSha);
    console.log('Restarting Envoi container for the deployed release');
    await this.stop();
    return true;
  }

  onStart() {
    console.log('Envoi container started');
  }

  onStop({ exitCode, reason }) {
    console.log('Envoi container stopped', { exitCode, reason });
  }

  onError(error) {
    console.error('Envoi container failed', {
      name: error instanceof Error ? error.name : 'Error'
    });
    throw error;
  }
}

async function probeContainer(env) {
  const container = getContainer(env.SINALOA_CONTAINER, CONTAINER_NAME);
  const response = await container.fetch(new Request('https://sinaloa-container.internal/ready', {
    method: 'GET',
    headers: { 'user-agent': 'envoi-cloudflare-wake/1.0' },
    signal: AbortSignal.timeout(25_000)
  }));
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Container readiness probe returned ${response.status}`);
  }
  const reported = await response.json().catch(() => null);
  const expected = selectEnvironment(env, ['ENVOI_RELEASE_SHA']).ENVOI_RELEASE_SHA;
  if (releaseIsStale(expected, reported?.releaseSha)) await container.restartForRelease(expected);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.ENVOI_EDGE_ALLOWED_HOSTS !== undefined && env.SINALOA_EDGE_ALLOWED_HOSTS !== undefined
      && env.ENVOI_EDGE_ALLOWED_HOSTS !== env.SINALOA_EDGE_ALLOWED_HOSTS) return serviceUnavailableResponse();
    if (!isAllowedHostname(url, env.ENVOI_EDGE_ALLOWED_HOSTS ?? env.SINALOA_EDGE_ALLOWED_HOSTS)) {
      return new Response('Misdirected Request', {
        status: 421,
        headers: { 'cache-control': 'private, no-store' }
      });
    }

    try {
      const container = getContainer(env.SINALOA_CONTAINER, CONTAINER_NAME);
      const response = await container.fetch(createForwardedRequest(request));
      return withNoStoreHeaders(response);
    } catch (error) {
      console.error('Envoi container request failed', {
        name: error instanceof Error ? error.name : 'Error'
      });
      return serviceUnavailableResponse();
    }
  },

  async scheduled(_controller, env) {
    await probeContainer(env);
  }
};
