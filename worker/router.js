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
    const value = source?.[key];
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  return selected;
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
  return new Response(JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'Sinaloa is temporarily unavailable' }), {
    status: 503,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5'
    }
  });
}
