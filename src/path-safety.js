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

export function assertSafeRequestTarget(requestTarget) {
  const rawPath = String(requestTarget || '').split('?', 1)[0];
  if (!rawPath.startsWith('/') || rawPath.length > 8192 || CONTROL_CHARACTERS.test(rawPath)) throw new TypeError('Request path is invalid');
  for (const rawSegment of rawPath.split('/').slice(1)) {
    if (!rawSegment) continue;
    let segment;
    try { segment = decodeURIComponent(rawSegment); }
    catch { throw new TypeError('Request path encoding is invalid'); }
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 || CONTROL_CHARACTERS.test(segment) || /[\\/]/.test(segment)) {
      throw new TypeError('Request path contains an unsafe segment');
    }
  }
  return true;
}
