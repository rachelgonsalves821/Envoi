const normalizeHostname = value => String(value || '').trim().toLowerCase().replace(/\.$/, '');

export function parseAllowedHostnames(value) {
  return new Set(String(value || '')
    .split(',')
    .map(normalizeHostname)
    .filter(Boolean));
}

export function isAllowedHostname(url, configuredHostnames) {
  const allowed = parseAllowedHostnames(configuredHostnames);
  return allowed.has(normalizeHostname(url.hostname));
}

export function selectEnvironment(source, keys, defaults = {}) {
  const selected = { ...defaults };
  for (const key of keys) {
    const legacyKey = key.startsWith('ENVOI_') ? `SINALOA_${key.slice('ENVOI_'.length)}` : null;
    const value = source?.[key] ?? (legacyKey ? source?.[legacyKey] : undefined);
    if (legacyKey && source?.[key] !== undefined && source?.[legacyKey] !== undefined && source[key] !== source[legacyKey]) {
      throw new Error(`Conflicting Envoi environment aliases: ${key} and ${legacyKey}`);
    }
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  return selected;
}

// A container keeps the environment it was started with. A rollout can restart it
// with the previous Worker version's variables, so the reported release may lag.
export function releaseIsStale(expectedSha, reportedSha) {
  return /^[a-f0-9]{40}$/.test(expectedSha || '') && reportedSha !== expectedSha;
}

// A digest of the settings a container is started with, so a dashboard edit (a new Worker
// version with the same release) can be detected. It is stored privately; never log it.
export async function environmentFingerprint(envVars) {
  const entries = Object.entries(envVars || {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(entries)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Restart only when the running container's settings are known and differ from the Worker's,
// and at most once per new set of settings, so a container that still disagrees cannot flap.
export function settingsChanged(startedFingerprint, currentFingerprint, lastRestartFingerprint) {
  return Boolean(startedFingerprint) && startedFingerprint !== currentFingerprint && lastRestartFingerprint !== currentFingerprint;
}

export function createForwardedRequest(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const clientIp = headers.get('cf-connecting-ip');

  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-port', url.port || (url.protocol === 'https:' ? '443' : '80'));
  if (clientIp) {
    headers.set('x-real-ip', clientIp);
    headers.set('x-forwarded-for', clientIp);
  } else {
    headers.delete('x-real-ip');
    headers.delete('x-forwarded-for');
  }

  return new Request(request, { headers });
}

export function withNoStoreHeaders(response) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function serviceUnavailableResponse() {
  return new Response(JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'Envoi is temporarily unavailable' }), {
    status: 503,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5'
    }
  });
}
