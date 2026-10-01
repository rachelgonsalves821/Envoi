import { sessionCookieHeader, sessionCookieName } from './workos-auth.js';

// Refresh is resolved during authentication. Attach its replacement cookie at
// the final header write, including streaming responses, without losing CSRF
// or overriding an explicit logout/callback session cookie.
export function installSessionCookieResponse(req, res, auth) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const renewed = auth.takeSessionCookie?.(req);
    if (renewed && !this.headersSent) {
      const index = typeof args[1] === 'string' ? 2 : 1;
      const supplied = args[index];
      const explicit = Array.isArray(supplied)
        ? supplied.flatMap((value, position) => position % 2 === 0 && String(value).toLowerCase() === 'set-cookie' ? [supplied[position + 1]] : [])
        : Object.entries(supplied || {}).filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value).flat();
      const current = explicit.length ? explicit : [this.getHeader('set-cookie')].filter(Boolean).flat();
      const hasSession = current.some(value => String(value).startsWith(`${sessionCookieName()}=`));
      if (!hasSession) {
        const cookies = [...current, sessionCookieHeader(renewed)];
        if (explicit.length && Array.isArray(supplied)) {
          args[index] = supplied.filter((value, position) => {
            const name = position % 2 === 0 ? value : supplied[position - 1];
            return String(name).toLowerCase() !== 'set-cookie';
          }).concat(['Set-Cookie', cookies]);
        } else if (explicit.length) {
          args[index] = Object.fromEntries(Object.entries(supplied).filter(([name]) => name.toLowerCase() !== 'set-cookie'));
          args[index]['set-cookie'] = cookies;
        } else this.setHeader('set-cookie', cookies);
      }
    }
    return writeHead.apply(this, args);
  };
}