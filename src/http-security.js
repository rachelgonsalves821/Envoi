import crypto from 'node:crypto';
import net from 'node:net';

function normalizedIp(value) {
  const candidate = String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
  return net.isIP(candidate) ? candidate : '';
}

export function clientIp(req, trustedProxy = process.env.SINALOA_TRUSTED_PROXY) {
  if (trustedProxy === 'cloudflare') {
    const forwarded = normalizedIp(req.headers?.['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return normalizedIp(req.socket?.remoteAddress) || 'unknown';
}

export function publicHttpError(error, requestId = crypto.randomUUID()) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status === 503 && error?.code === 'auth_unavailable') {
    return {
      status,
      body: { error: 'AUTH_UNAVAILABLE', message: 'Your session could not be checked right now. Please try again.', requestId }
    };
  }
  if (status >= 500) {
    return {
      status,
      body: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An internal error occurred',
        requestId
      }
    };
  }
  return {
    status,
    body: {
      error: error?.code || 'REQUEST_FAILED',
      message: String(error?.message || 'Request failed'),
      requestId
    }
  };
}
