export class BrowserSession {
  constructor() { this.cookies = new Map(); }

  capture(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')?.split(/,\s*(?=[^;,=]+=[^;,]*)/) || [];
    for (const value of values) {
      const [pair, ...attributes] = value.split(';').map(item => item.trim());
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      if (attributes.some(item => item.toLowerCase() === 'max-age=0')) this.cookies.delete(name);
      else this.cookies.set(name, content);
    }
  }

  headers(baseUrl, method) {
    if (!this.cookies.size) return {};
    const headers = { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      const csrf = this.cookies.get('sinaloa_csrf');
      if (csrf) {
        headers.origin = new URL(baseUrl).origin;
        headers['x-sinaloa-csrf'] = decodeURIComponent(csrf);
      }
    }
    return headers;
  }
}
