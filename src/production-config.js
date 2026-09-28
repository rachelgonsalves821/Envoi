const required = (env, name, errors, minimumLength = 1) => {
  const value = String(env[name] || '').trim();
  if (value.length < minimumLength) errors.push(`${name} is required${minimumLength > 1 ? ` and must be at least ${minimumLength} characters` : ''}`);
  return value;
};

const httpsUrl = (value, name, errors) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') errors.push(`${name} must use HTTPS`);
    return parsed;
  } catch {
    errors.push(`${name} must be a valid HTTPS URL`);
    return null;
  }
};

export function validateProductionConfiguration(env = process.env) {
  if (env.SINALOA_AUTH_MODE !== 'production') return { mode: env.SINALOA_AUTH_MODE || 'development', validated: false };
  const errors = [];
  const publicUrl = httpsUrl(required(env, 'SINALOA_PUBLIC_URL', errors), 'SINALOA_PUBLIC_URL', errors);
  const databaseUrl = required(env, 'DATABASE_URL', errors);
  if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) errors.push('DATABASE_URL must be a PostgreSQL connection URL');
  if ((env.SINALOA_HUMAN_AUTH_PROVIDER || 'workos') !== 'workos') errors.push('SINALOA_HUMAN_AUTH_PROVIDER must be workos in production');
  required(env, 'WORKOS_CLIENT_ID', errors);
  required(env, 'WORKOS_API_KEY', errors);
  required(env, 'WORKOS_COOKIE_PASSWORD', errors, 32);
  const redirectUri = httpsUrl(required(env, 'WORKOS_REDIRECT_URI', errors), 'WORKOS_REDIRECT_URI', errors);
  if (publicUrl && redirectUri && publicUrl.origin !== redirectUri.origin) errors.push('WORKOS_REDIRECT_URI must use the SINALOA_PUBLIC_URL origin');
  const encryptionKey = required(env, 'SINALOA_DATA_ENCRYPTION_KEY', errors, 32);
  if (/development|changeme|example|sinaloa-development-only/i.test(encryptionKey)) errors.push('SINALOA_DATA_ENCRYPTION_KEY must not use a development or example value');
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

  if (errors.length) throw new Error(`Invalid production configuration:\n- ${[...new Set(errors)].join('\n- ')}`);
  return { mode: 'production', validated: true, publicOrigin: publicUrl.origin, corsOrigins: origins, platformDomain, externalEmailEnabled, emailDomain, objectStorageProvider: 's3', humanAuthProvider: 'workos' };
}
