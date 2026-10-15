import { assertDatabaseTarget } from './consumer-identity.js';
import { applyLegacyEnvironmentFallbacks, assertNoRetiredEnvironment } from './envoi-environment.js';

const positiveInteger = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

export function createPostgresOptions(connectionString, env = process.env, overrides = {}) {
  // N2-config-2: SINALOA_DB_SSL_MODE would otherwise be ignored, silently dropping TLS.
  assertNoRetiredEnvironment(env);
  env = applyLegacyEnvironmentFallbacks({ ...env });
  if (!connectionString) throw new Error('DATABASE_URL is required');
  assertDatabaseTarget(connectionString, env.ENVOI_EXPECTED_DATABASE_FINGERPRINT);
  const parsed = new URL(connectionString);
  // Do not let an inherited PGPORT silently change a destination pinned with the default port.
  if (!parsed.port) parsed.port = '5432';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  const forbiddenTlsParameters = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'];
  if (forbiddenTlsParameters.some(name => parsed.searchParams.has(name))) {
    throw new Error('Configure PostgreSQL TLS with ENVOI_DB_SSL_MODE and ENVOI_DB_CA, not DATABASE_URL query parameters');
  }

  const production = env.ENVOI_AUTH_MODE === 'production';
  const sslMode = env.ENVOI_DB_SSL_MODE || (env.ENVOI_DB_SSL === 'true' ? 'verify-full' : 'disable');
  if (!['disable', 'verify-full'].includes(sslMode)) throw new Error('ENVOI_DB_SSL_MODE must be disable or verify-full');
  if (production && sslMode !== 'verify-full') throw new Error('ENVOI_DB_SSL_MODE must be verify-full in production');

  // pg gives URL parameters precedence over object options; stamp our identity into the URL.
  if (overrides.applicationName) parsed.searchParams.set('application_name', overrides.applicationName);

  return {
    connectionString: parsed.toString(),
    max: positiveInteger(env, 'ENVOI_DB_POOL_SIZE', overrides.max ?? 10),
    connectionTimeoutMillis: positiveInteger(env, 'ENVOI_DB_CONNECT_TIMEOUT_MS', 10_000),
    statement_timeout: positiveInteger(env, 'ENVOI_DB_STATEMENT_TIMEOUT_MS', 30_000),
    query_timeout: positiveInteger(env, 'ENVOI_DB_QUERY_TIMEOUT_MS', 30_000),
    ssl: sslMode === 'verify-full'
      ? { rejectUnauthorized: true, ...(env.ENVOI_DB_CA ? { ca: env.ENVOI_DB_CA } : {}) }
      : undefined
  };
}
