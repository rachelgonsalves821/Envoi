import { scannerHealthUrl } from './dependency-readiness.js';
import { createPostgresOptions } from './postgres-options.js';

const required = (env, name, errors, minimumLength = 1) => {
  const value = String(env[name] || '').trim();
  if (value.length < minimumLength) errors.push(`${name} is required${minimumLength > 1 ? ` and must be at least ${minimumLength} characters` : ''}`);
  return value;
};

const httpsUrl = (value, name, errors) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') errors.push(`${name} must use HTTPS`);
    if (parsed.username || parsed.password) errors.push(`${name} must not contain embedded credentials`);
    return parsed;
  } catch {
    errors.push(`${name} must be a valid HTTPS URL`);
    return null;
  }
};

export function validateProductionConfiguration(env = process.env) {
  if (env.SINALOA_AUTH_MODE !== 'production') return { mode: env.SINALOA_AUTH_MODE || 'development', validated: false };
  const errors = [];
  if (env.SINALOA_RELEASE_SHA !== undefined && !/^[a-f0-9]{40}$/.test(env.SINALOA_RELEASE_SHA)) errors.push('SINALOA_RELEASE_SHA must be a full lowercase 40-character Git commit SHA');
  const publicUrl = httpsUrl(required(env, 'SINALOA_PUBLIC_URL', errors), 'SINALOA_PUBLIC_URL', errors);
  const databaseUrl = required(env, 'DATABASE_URL', errors);
  if (databaseUrl) {
    try {
      // Use the same parser and TLS rules as startup, before a container is built.
      const options = createPostgresOptions(databaseUrl, env);
      if (!new URL(options.connectionString).hostname) errors.push('DATABASE_URL must include a PostgreSQL hostname');
    } catch (error) {
      errors.push(error.code === 'ERR_INVALID_URL' ? 'DATABASE_URL must be a valid PostgreSQL connection URL' : error.message);
    }
  }
  if ((env.SINALOA_DB_SSL_MODE || (env.SINALOA_DB_SSL === 'true' ? 'verify-full' : 'disable')) !== 'verify-full') errors.push('SINALOA_DB_SSL_MODE must be verify-full in production');
  if ((env.SINALOA_HUMAN_AUTH_PROVIDER || 'workos') !== 'workos') errors.push('SINALOA_HUMAN_AUTH_PROVIDER must be workos in production');
  required(env, 'WORKOS_CLIENT_ID', errors);
  required(env, 'WORKOS_API_KEY', errors);
  required(env, 'WORKOS_COOKIE_PASSWORD', errors, 32);
  const invitedEmails = required(env, 'SINALOA_BETA_INVITED_EMAILS', errors).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (invitedEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.push('SINALOA_BETA_INVITED_EMAILS must contain exact email addresses');
  const redirectUri = httpsUrl(required(env, 'WORKOS_REDIRECT_URI', errors), 'WORKOS_REDIRECT_URI', errors);
  if (publicUrl && redirectUri && publicUrl.origin !== redirectUri.origin) errors.push('WORKOS_REDIRECT_URI must use the SINALOA_PUBLIC_URL origin');
  const encryptionKey = required(env, 'SINALOA_DATA_ENCRYPTION_KEY', errors, 32);
  if (/development|changeme|example|sinaloa-development-only/i.test(encryptionKey)) errors.push('SINALOA_DATA_ENCRYPTION_KEY must not use a development or example value');
  const policyActiveKeyId = required(env, 'SINALOA_POLICY_ACTIVE_KEY_ID', errors);
  let policySigningKeys = {};
  if (env.SINALOA_POLICY_SIGNING_KEYS) {
    try {
      policySigningKeys = JSON.parse(env.SINALOA_POLICY_SIGNING_KEYS);
    } catch {
      errors.push('SINALOA_POLICY_SIGNING_KEYS must be a JSON object');
    }
  } else if (env.SINALOA_POLICY_SIGNING_KEY) {
    policySigningKeys = { [policyActiveKeyId]: env.SINALOA_POLICY_SIGNING_KEY };
  }
  if (!policySigningKeys || typeof policySigningKeys !== 'object' || Array.isArray(policySigningKeys)) errors.push('SINALOA_POLICY_SIGNING_KEYS must be a JSON object');
  if (typeof policySigningKeys?.[policyActiveKeyId] !== 'string' || policySigningKeys[policyActiveKeyId].length < 32) errors.push('The active policy signing key must be at least 32 characters');
  for (const [keyId, value] of Object.entries(policySigningKeys || {})) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyId) || typeof value !== 'string' || value.length < 32) errors.push('Every policy signing key ID and value must be valid');
    if (typeof value === 'string' && /development|changeme|example/i.test(value)) errors.push('Policy signing keys must not use development or example values');
  }
  const policyTtl = Number(env.SINALOA_POLICY_DECISION_TTL_SECONDS || 600);
  if (!Number.isSafeInteger(policyTtl) || policyTtl < 30 || policyTtl > 3600) errors.push('SINALOA_POLICY_DECISION_TTL_SECONDS must be an integer from 30 to 3600');
  const policyTolerance = Number(env.SINALOA_POLICY_EXECUTE_AT_TOLERANCE_SECONDS || 60);
  if (!Number.isSafeInteger(policyTolerance) || policyTolerance < 0 || policyTolerance > 3600) errors.push('SINALOA_POLICY_EXECUTE_AT_TOLERANCE_SECONDS must be an integer from 0 to 3600');
  const automaticPaymentLimit = Number(env.SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR || 0);
  if (!Number.isSafeInteger(automaticPaymentLimit) || automaticPaymentLimit < 0) errors.push('SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR must be a non-negative safe integer');
  if (env.SINALOA_COOKIE_SECURE !== 'true') errors.push('SINALOA_COOKIE_SECURE must be true in production');
  if (!['Lax', 'Strict'].includes(env.SINALOA_COOKIE_SAMESITE || 'Lax')) errors.push('SINALOA_COOKIE_SAMESITE must be Lax or Strict in production');

  const origins = String(env.SINALOA_CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*')) errors.push('SINALOA_CORS_ORIGIN must contain explicit HTTPS origins');
  for (const origin of origins) {
    const parsed = httpsUrl(origin, 'SINALOA_CORS_ORIGIN', errors);
    if (parsed && (parsed.pathname !== '/' || parsed.search || parsed.hash)) errors.push('SINALOA_CORS_ORIGIN entries must be origins without paths, queries, or fragments');
  }
  if (publicUrl && origins.length && !origins.includes(publicUrl.origin)) errors.push('SINALOA_CORS_ORIGIN must include the SINALOA_PUBLIC_URL origin');

  if (env.SINALOA_OBJECT_STORAGE_PROVIDER !== 's3') errors.push('SINALOA_OBJECT_STORAGE_PROVIDER must be s3 in production');
  httpsUrl(required(env, 'SINALOA_S3_ENDPOINT', errors), 'SINALOA_S3_ENDPOINT', errors);
  required(env, 'SINALOA_S3_BUCKET', errors);
  required(env, 'SINALOA_S3_REGION', errors);
  required(env, 'SINALOA_S3_ACCESS_KEY_ID', errors);
  required(env, 'SINALOA_S3_SECRET_ACCESS_KEY', errors);
  httpsUrl(required(env, 'SINALOA_MALWARE_SCANNER_URL', errors), 'SINALOA_MALWARE_SCANNER_URL', errors);
  required(env, 'SINALOA_MALWARE_SCANNER_TOKEN', errors);
  if (env.SINALOA_MALWARE_SCANNER_HEALTH_URL) {
    httpsUrl(env.SINALOA_MALWARE_SCANNER_HEALTH_URL, 'SINALOA_MALWARE_SCANNER_HEALTH_URL', errors);
    try { scannerHealthUrl(env); } catch { errors.push('SINALOA_MALWARE_SCANNER_HEALTH_URL must use the scanner origin without embedded credentials'); }
  }

  const validDomain = value => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) && !value.endsWith('.mail');
  const platformDomain = required(env, 'SINALOA_AGENT_DOMAIN', errors).toLowerCase();
  if (!validDomain(platformDomain)) errors.push('SINALOA_AGENT_DOMAIN must be a registrable public DNS name and cannot use .mail in production');
  const externalEmailEnabled = env.SINALOA_ENABLE_EXTERNAL_EMAIL === 'true';
  let emailDomain = null;
  if (externalEmailEnabled) {
    if (env.SINALOA_EMAIL_PROVIDER !== 'resend') errors.push('SINALOA_EMAIL_PROVIDER must be resend when external email is enabled');
    emailDomain = required(env, 'SINALOA_PUBLIC_EMAIL_DOMAIN', errors).toLowerCase();
    if (!validDomain(emailDomain)) errors.push('SINALOA_PUBLIC_EMAIL_DOMAIN must be a registrable public DNS name and cannot use .mail');
    if (env.SINALOA_EMAIL_DOMAIN_VERIFIED !== 'true') errors.push('SINALOA_EMAIL_DOMAIN_VERIFIED must be true after provider DNS verification');
    required(env, 'RESEND_API_KEY', errors);
    required(env, 'RESEND_WEBHOOK_SECRET', errors);
  }

  if (env.SINALOA_ENABLE_CALENDAR_WRITES === 'true') {
    const providers = [
      ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REDIRECT_URI'],
      ['MICROSOFT_CALENDAR_CLIENT_ID', 'MICROSOFT_CALENDAR_CLIENT_SECRET', 'MICROSOFT_CALENDAR_REDIRECT_URI']
    ];
    const configured = providers.filter(names => names.every(name => String(env[name] || '').trim()));
    if (!configured.length) errors.push('At least one complete calendar OAuth provider is required when calendar writes are enabled');
    for (const names of providers) {
      const present = names.filter(name => String(env[name] || '').trim());
      if (present.length && present.length !== names.length) errors.push(`${names[0].replace('_CLIENT_ID', '')} OAuth configuration must include client ID, client secret, and redirect URI`);
      if (present.length === names.length) {
        const providerRedirect = httpsUrl(env[names[2]], names[2], errors);
        if (providerRedirect && publicUrl && providerRedirect.origin !== publicUrl.origin) errors.push(`${names[2]} must use the SINALOA_PUBLIC_URL origin`);
      }
    }
  }

  const positiveIntegerVariables = [
    'SINALOA_PORT', 'SINALOA_MAX_BODY_BYTES', 'SINALOA_DB_POOL_SIZE', 'SINALOA_DB_CONNECT_TIMEOUT_MS',
    'SINALOA_DB_STATEMENT_TIMEOUT_MS', 'SINALOA_DB_QUERY_TIMEOUT_MS', 'SINALOA_REQUEST_TIMEOUT_MS',
    'SINALOA_READINESS_TIMEOUT_MS', 'SINALOA_MAX_SSE_PER_PRINCIPAL', 'SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS',
    'SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS', 'SINALOA_DELIVERY_MAX_ATTEMPTS', 'SINALOA_DELIVERY_POLL_MS',
    'SINALOA_DELIVERY_LEASE_MS', 'SINALOA_DELIVERY_RETRY_BASE_MS', 'SINALOA_DELIVERY_RETRY_MAX_MS',
    'SINALOA_OBJECT_MAX_BYTES', 'SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES', 'SINALOA_OBJECT_QUOTA_REAPER_INTERVAL_MS',
    'SINALOA_S3_REQUEST_TIMEOUT_MS', 'SINALOA_SCAN_WORKER_INTERVAL_MS', 'SINALOA_SCAN_RETENTION_INTERVAL_MS',
    'SINALOA_SCAN_MAX_ATTEMPTS', 'SINALOA_SCAN_LEASE_MS', 'SINALOA_SCAN_RETRY_BASE_MS', 'SINALOA_SCAN_RETRY_MAX_MS',
    'SINALOA_SCAN_INFECTED_RETENTION_MS', 'SINALOA_SCAN_DEAD_LETTER_RETENTION_MS', 'SINALOA_SCAN_COMPLETED_JOB_RETENTION_MS', 'SINALOA_SCAN_RETENTION_RETRY_MS',
    'SINALOA_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT', 'SINALOA_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT',
    'SINALOA_CALENDAR_OAUTH_TIMEOUT_MS', 'SINALOA_OTP_EXPIRY_MINUTES', 'SINALOA_SESSION_HOURS', 'SINALOA_AUTH_FLOW_MINUTES'
  ];
  for (const name of positiveIntegerVariables) {
    if (env[name] !== undefined && (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) < 1)) errors.push(`${name} must be a positive integer`);
  }
  const maximums = {
    SINALOA_PORT: 65_535,
    SINALOA_MAX_BODY_BYTES: 104_857_600,
    SINALOA_DB_POOL_SIZE: 200,
    SINALOA_DB_CONNECT_TIMEOUT_MS: 120_000,
    SINALOA_DB_STATEMENT_TIMEOUT_MS: 120_000,
    SINALOA_DB_QUERY_TIMEOUT_MS: 120_000,
    SINALOA_REQUEST_TIMEOUT_MS: 120_000,
    SINALOA_READINESS_TIMEOUT_MS: 120_000,
    SINALOA_MAX_SSE_PER_PRINCIPAL: 1_000,
    SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS: 86_400,
    SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS: 365,
    SINALOA_DELIVERY_MAX_ATTEMPTS: 100,
    SINALOA_S3_REQUEST_TIMEOUT_MS: 120_000,
    SINALOA_CALENDAR_OAUTH_TIMEOUT_MS: 120_000,
    SINALOA_DELIVERY_POLL_MS: 2_147_483_647,
    SINALOA_DELIVERY_LEASE_MS: 2_147_483_647,
    SINALOA_DELIVERY_RETRY_BASE_MS: 2_147_483_647,
    SINALOA_DELIVERY_RETRY_MAX_MS: 2_147_483_647,
    SINALOA_OBJECT_QUOTA_REAPER_INTERVAL_MS: 2_147_483_647,
    SINALOA_OBJECT_MAX_BYTES: 5_368_709_120,
    SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES: 1_099_511_627_776,
    SINALOA_SCAN_WORKER_INTERVAL_MS: 2_147_483_647,
    SINALOA_SCAN_RETENTION_INTERVAL_MS: 2_147_483_647,
    SINALOA_SCAN_MAX_ATTEMPTS: 100,
    SINALOA_SCAN_LEASE_MS: 2_147_483_647,
    SINALOA_SCAN_RETRY_BASE_MS: 2_147_483_647,
    SINALOA_SCAN_RETRY_MAX_MS: 2_147_483_647,
    SINALOA_SCAN_INFECTED_RETENTION_MS: 31_536_000_000,
    SINALOA_SCAN_DEAD_LETTER_RETENTION_MS: 31_536_000_000,
    SINALOA_SCAN_COMPLETED_JOB_RETENTION_MS: 31_536_000_000,
    SINALOA_SCAN_RETENTION_RETRY_MS: 2_147_483_647,
    SINALOA_OTP_EXPIRY_MINUTES: 60,
    SINALOA_SESSION_HOURS: 720,
    SINALOA_AUTH_FLOW_MINUTES: 60,
    SINALOA_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT: 100_000,
    SINALOA_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT: 100_000
  };
  for (const [name, maximum] of Object.entries(maximums)) {
    if (env[name] !== undefined && Number(env[name]) > maximum) errors.push(`${name} must not exceed ${maximum}`);
  }
  if (env.SINALOA_DELIVERY_RETRY_BASE_MS !== undefined && env.SINALOA_DELIVERY_RETRY_MAX_MS !== undefined && Number(env.SINALOA_DELIVERY_RETRY_BASE_MS) > Number(env.SINALOA_DELIVERY_RETRY_MAX_MS)) errors.push('SINALOA_DELIVERY_RETRY_BASE_MS must not exceed SINALOA_DELIVERY_RETRY_MAX_MS');
  if (env.SINALOA_SCAN_RETRY_BASE_MS !== undefined && env.SINALOA_SCAN_RETRY_MAX_MS !== undefined && Number(env.SINALOA_SCAN_RETRY_BASE_MS) > Number(env.SINALOA_SCAN_RETRY_MAX_MS)) errors.push('SINALOA_SCAN_RETRY_BASE_MS must not exceed SINALOA_SCAN_RETRY_MAX_MS');

  if (errors.length) throw new Error(`Invalid production configuration:\n- ${[...new Set(errors)].join('\n- ')}`);
  return { mode: 'production', validated: true, publicOrigin: publicUrl.origin, corsOrigins: origins, platformDomain, externalEmailEnabled, emailDomain, objectStorageProvider: 's3', humanAuthProvider: 'workos', databaseTlsMode: 'verify-full', policyActiveKeyId };
}
