import { Container, getContainer } from '@cloudflare/containers';
import { env as runtimeEnv } from 'cloudflare:workers';
import {
  createForwardedRequest,
  isAllowedHostname,
  selectEnvironment,
  serviceUnavailableResponse,
  withNoStoreHeaders
} from './router.js';

const CONTAINER_NAME = 'sinaloa-beta-primary';
const CONTAINER_PORT = 8787;

const CONTAINER_ENV_KEYS = Object.freeze([
  'DATABASE_URL',
  'SINALOA_DB_POOL_SIZE',
  'SINALOA_DB_SSL',
  'SINALOA_DB_SSL_MODE',
  'SINALOA_DB_CA',
  'SINALOA_DB_CONNECT_TIMEOUT_MS',
  'SINALOA_DB_STATEMENT_TIMEOUT_MS',
  'SINALOA_DB_QUERY_TIMEOUT_MS',
  'SINALOA_CORS_ORIGIN',
  'SINALOA_MAX_BODY_BYTES',
  'SINALOA_DELIVERY_MAX_ATTEMPTS',
  'SINALOA_DELIVERY_POLL_MS',
  'SINALOA_DELIVERY_LEASE_MS',
  'SINALOA_DELIVERY_RETRY_BASE_MS',
  'SINALOA_DELIVERY_RETRY_MAX_MS',
  'SINALOA_REQUEST_TIMEOUT_MS',
  'SINALOA_READINESS_TIMEOUT_MS',
  'SINALOA_MAX_SSE_PER_PRINCIPAL',
  'SINALOA_AGENT_DOMAIN',
  'SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS',
  'SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS',
  'SINALOA_PUBLIC_URL',
  'SINALOA_COOKIE_SAMESITE',
  'SINALOA_CSRF_COOKIE_NAME',
  'WORKOS_CLIENT_ID',
  'WORKOS_API_KEY',
  'WORKOS_COOKIE_PASSWORD',
  'WORKOS_REDIRECT_URI',
  'WORKOS_ISSUER',
  'WORKOS_COOKIE_NAME',
  'WORKOS_COOKIE_DOMAIN',
  'SINALOA_DATA_ENCRYPTION_KEY',
  'SINALOA_ENABLE_EXTERNAL_EMAIL',
  'SINALOA_EMAIL_PROVIDER',
  'SINALOA_PUBLIC_EMAIL_DOMAIN',
  'SINALOA_EMAIL_DOMAIN_VERIFIED',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_API_BASE_URL',
  'SINALOA_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT',
  'SINALOA_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT',
  'SINALOA_ENABLE_CALENDAR_WRITES',
  'SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_REDIRECT_URI',
  'MICROSOFT_CALENDAR_CLIENT_ID',
  'MICROSOFT_CALENDAR_CLIENT_SECRET',
  'MICROSOFT_CALENDAR_REDIRECT_URI',
  'SINALOA_OBJECT_STORAGE_PROVIDER',
  'SINALOA_OBJECT_MAX_BYTES',
  'SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES',
  'SINALOA_OBJECT_ALLOWED_MIME_TYPES',
  'SINALOA_S3_ENDPOINT',
  'SINALOA_S3_BUCKET',
  'SINALOA_S3_REGION',
  'SINALOA_S3_ACCESS_KEY_ID',
  'SINALOA_S3_SECRET_ACCESS_KEY',
  'SINALOA_S3_SESSION_TOKEN',
  'SINALOA_MALWARE_SCANNER_URL',
  'SINALOA_MALWARE_SCANNER_TOKEN',
  'SINALOA_OBJECT_QUOTA_REAPER_INTERVAL_MS',
  'SINALOA_TRUSTED_PROXY'
]);

const CONTAINER_DEFAULTS = Object.freeze({
  NODE_ENV: 'production',
  SINALOA_AUTH_MODE: 'production',
  SINALOA_HUMAN_AUTH_PROVIDER: 'workos',
  SINALOA_HOST: '0.0.0.0',
  SINALOA_PORT: String(CONTAINER_PORT),
  SINALOA_COOKIE_SECURE: 'true',
  SINALOA_TRUSTED_PROXY: 'cloudflare'
});

export class SinaloaContainer extends Container {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = '5m';
  pingEndpoint = 'localhost/ready';
  enableInternet = true;
  envVars = selectEnvironment(runtimeEnv, CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS);

  onStart() {
    console.log('Sinaloa container started');
  }

  onStop({ exitCode, reason }) {
    console.log('Sinaloa container stopped', { exitCode, reason });
  }

  onError(error) {
    console.error('Sinaloa container failed', {
      name: error instanceof Error ? error.name : 'Error'
    });
    throw error;
  }
}

async function probeContainer(env) {
  const container = getContainer(env.SINALOA_CONTAINER, CONTAINER_NAME);
  const response = await container.fetch(new Request('https://sinaloa-container.internal/ready', {
    method: 'GET',
    headers: { 'user-agent': 'sinaloa-cloudflare-wake/1.0' },
    signal: AbortSignal.timeout(25_000)
  }));
  response.body?.cancel();
  if (!response.ok) throw new Error(`Container readiness probe returned ${response.status}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!isAllowedHostname(url, env.SINALOA_EDGE_ALLOWED_HOSTS)) {
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
      console.error('Sinaloa container request failed', {
        name: error instanceof Error ? error.name : 'Error'
      });
      return serviceUnavailableResponse();
    }
  },

  async scheduled(_controller, env) {
    await probeContainer(env);
  }
};
