const positiveInteger = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

export function createPostgresOptions(connectionString, env = process.env, overrides = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  const forbiddenTlsParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
  if (forbiddenTlsParameters.some(name => parsed.searchParams.has(name))) {
    throw new Error('Configure PostgreSQL TLS with SINALOA_DB_SSL_MODE and SINALOA_DB_CA, not DATABASE_URL query parameters');
  }

  const production = env.SINALOA_AUTH_MODE === 'production';
  const sslMode = env.SINALOA_DB_SSL_MODE || (env.SINALOA_DB_SSL === 'true' ? 'verify-full' : 'disable');
  if (!['disable', 'verify-full'].includes(sslMode)) throw new Error('SINALOA_DB_SSL_MODE must be disable or verify-full');
  if (production && sslMode !== 'verify-full') throw new Error('SINALOA_DB_SSL_MODE must be verify-full in production');

  return {
    connectionString: parsed.toString(),
    max: positiveInteger(env, 'SINALOA_DB_POOL_SIZE', overrides.max ?? 10),
    connectionTimeoutMillis: positiveInteger(env, 'SINALOA_DB_CONNECT_TIMEOUT_MS', 10_000),
    statement_timeout: positiveInteger(env, 'SINALOA_DB_STATEMENT_TIMEOUT_MS', 30_000),
    query_timeout: positiveInteger(env, 'SINALOA_DB_QUERY_TIMEOUT_MS', 30_000),
    ssl: sslMode === 'verify-full'
      ? { rejectUnauthorized: true, ...(env.SINALOA_DB_CA ? { ca: env.SINALOA_DB_CA } : {}) }
      : undefined
  };
}
