import path from 'node:path';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

export function normalizeDocumentPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError('Document path is invalid');
  }
  if (path.isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) throw new TypeError('Document path must be relative');
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 255)) {
    throw new TypeError('Document path contains an unsafe segment');
  }
  return segments.join('/');
}

export function resolvePathWithin(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const logicalPath = parts.map(part => normalizeDocumentPath(String(part))).join('/');
  const target = path.resolve(resolvedRoot, ...logicalPath.split('/'));
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    if (!relative) return target;
    throw new TypeError('Resolved path escapes its configured root');
  }
  return target;
}

export function assertSafeIdentifier(value, name = 'Identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw Object.assign(new TypeError(`${name} is invalid`), { statusCode: 400 });
  }
  return value;
}

// agent-remote-auth §5: the consent routes carry a sealed authorization request handle (up to 2,048 characters) as one
// segment. Only that segment is exempt from the 255-character limit, so the route itself answers an over-long handle
// with AUTHORIZATION_REQUEST_INVALID. The handle is never used as a storage path.
const CONSENT_HANDLE_PATH = /^\/api\/oauth\/authorization-requests\/[^/]+(?:\/(?:approve|deny))?$/;

export function assertSafeRequestTarget(requestTarget) {
  const rawPath = String(requestTarget || '').split('?', 1)[0];
  if (!rawPath.startsWith('/') || rawPath.length > 8192 || CONTROL_CHARACTERS.test(rawPath)) throw new TypeError('Request path is invalid');
  const longSegment = CONSENT_HANDLE_PATH.test(rawPath) ? 4 : -1;
  for (const [index, rawSegment] of rawPath.split('/').entries()) {
    if (!rawSegment) continue;
    let segment;
    try { segment = decodeURIComponent(rawSegment); }
    catch { throw new TypeError('Request path encoding is invalid'); }
    if (!segment || segment === '.' || segment === '..' || (index !== longSegment && segment.length > 255) || CONTROL_CHARACTERS.test(segment) || /[\\/]/.test(segment)) {
      throw new TypeError('Request path contains an unsafe segment');
    }
  }
  return true;
}
