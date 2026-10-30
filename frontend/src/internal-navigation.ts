export const INTERNAL_ROUTE_EVENT = 'envoi:internal-route';

const internalPaths = new Set(['/app', '/claim', '/connect', '/authorize-agent']);

export function internalRoute(href: string, origin: string, target = '', download = false, modified = false, button = 0): string | null {
  if (modified || button !== 0 || download || (target && target !== '_self')) return null;
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin || !internalPaths.has(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function navigateInternal(path: string) {
  const route = internalRoute(path, window.location.origin);
  if (!route) throw new Error('Unsupported internal route');
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === route) return;
  window.history.pushState(null, '', route);
  window.dispatchEvent(new Event(INTERNAL_ROUTE_EVENT));
}
