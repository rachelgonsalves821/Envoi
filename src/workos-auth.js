import crypto from 'node:crypto';
import path from 'node:path';
import { WorkOS } from '@workos-inc/node';

// Authorization must follow current provider membership, including demotions.
// Sealed-session role/permission claims can outlive a membership change.
export const providerMembershipCanManage = membership => membership?.status === 'active'
  && ['owner', 'admin'].includes(String(membership.role?.slug || '').toLowerCase());

export const membershipCanManage = (membership, provider = 'local') => membership?.status === 'active'
  && ['owner', 'admin'].includes(String(membership.role || '').toLowerCase())
  && (provider !== 'workos' || providerMembershipCanManage(membership.providerMembership));

const flowMinutes = Number(process.env.SINALOA_AUTH_FLOW_MINUTES || 10);
const sessionCookie = process.env.WORKOS_COOKIE_NAME || 'sinaloa_session';
const csrfCookie = process.env.SINALOA_CSRF_COOKIE_NAME || 'sinaloa_csrf';
const requestHuman = Symbol('workos-request-human');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const safeReturnPath = value => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    let decoded = value;
    for (let index = 0; index < 2; index += 1) decoded = decodeURIComponent(decoded);
    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) return '/';
    const origin = 'https://sinaloa.invalid';
    const resolved = new URL(value, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : '/';
  } catch {
    return '/';
  }
};
const publicHuman = human => ({
  id: human.id,
  displayName: human.displayName,
  email: human.email,
  emailVerified: human.emailVerified,
  authProvider: human.authProvider,
  verifiedAt: human.verifiedAt,
  createdAt: human.createdAt
});

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(value => value.trim()).filter(Boolean).map(value => {
    const separator = value.indexOf('=');
    return separator < 0 ? [value, ''] : [value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))];
  }));
}

export function sessionCookieName() { return sessionCookie; }
export function sessionCookieHeader(value, { clear = false } = {}) {
  const secure = process.env.SINALOA_AUTH_MODE === 'production' || process.env.SINALOA_COOKIE_SECURE === 'true';
  const configuredSameSite = process.env.SINALOA_COOKIE_SAMESITE || 'Lax';
  const sameSite = ['Lax', 'Strict', 'None'].includes(configuredSameSite) ? configuredSameSite : 'Lax';
  const attributes = [`${sessionCookie}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) attributes.push('Secure');
  if (process.env.WORKOS_COOKIE_DOMAIN && /^[a-z0-9.-]+$/i.test(process.env.WORKOS_COOKIE_DOMAIN)) attributes.push(`Domain=${process.env.WORKOS_COOKIE_DOMAIN}`);
  if (clear) attributes.push('Max-Age=0');
  else attributes.push(`Max-Age=${Number(process.env.SINALOA_SESSION_HOURS || 24) * 3600}`);
  return attributes.join('; ');
}

export function createCsrfToken() { return crypto.randomBytes(32).toString('base64url'); }

export function csrfCookieHeader(value, { clear = false } = {}) {
  const secure = process.env.SINALOA_AUTH_MODE === 'production' || process.env.SINALOA_COOKIE_SECURE === 'true';
  const attributes = [`${csrfCookie}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (secure) attributes.push('Secure');
  if (clear) attributes.push('Max-Age=0');
  else attributes.push(`Max-Age=${Number(process.env.SINALOA_SESSION_HOURS || 24) * 3600}`);
  return attributes.join('; ');
}

export function verifyCsrfRequest(req) {
  const cookieToken = parseCookies(req.headers.cookie)[csrfCookie];
  const headerToken = String(req.headers['x-sinaloa-csrf'] || '');
  if (!cookieToken || !headerToken) return false;
  const cookieBytes = Buffer.from(cookieToken);
  const headerBytes = Buffer.from(headerToken);
  if (cookieBytes.length !== headerBytes.length || !crypto.timingSafeEqual(cookieBytes, headerBytes)) return false;
  try {
    const expectedOrigin = process.env.SINALOA_PUBLIC_URL
      ? new URL(process.env.SINALOA_PUBLIC_URL).origin
      : process.env.SINALOA_AUTH_MODE !== 'production' && req.headers.host
        ? `http://${req.headers.host}`
        : null;
    if (!expectedOrigin) return false;
    return String(req.headers.origin || '') === expectedOrigin;
  } catch {
    return false;
  }
}

export class WorkOSAuthService {
  constructor(store, options = {}) {
    this.store = store;
    this.provider = 'workos';
    this.clientId = options.clientId || process.env.WORKOS_CLIENT_ID;
    this.apiKey = options.apiKey || process.env.WORKOS_API_KEY;
    this.cookiePassword = options.cookiePassword || process.env.WORKOS_COOKIE_PASSWORD;
    this.redirectUri = options.redirectUri || process.env.WORKOS_REDIRECT_URI;
    this.issuer = options.issuer || process.env.WORKOS_ISSUER || (this.clientId ? `https://api.workos.com/user_management/${this.clientId}` : undefined);
    if (!this.clientId || !this.apiKey || !this.cookiePassword || !this.redirectUri) {
      throw new Error('WorkOS auth requires WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI');
    }
    if (this.cookiePassword.length < 32) throw new Error('WORKOS_COOKIE_PASSWORD must be at least 32 characters');
    this.workos = options.workos || new WorkOS(this.apiKey, { clientId: this.clientId, issuer: this.issuer });
    this.invitedEmails = new Set(String(options.invitedEmails ?? process.env.SINALOA_BETA_INVITED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  }

  config() {
    return { provider: 'workos', hosted: true, inviteOnly: true, signInPath: '/api/auth/workos/sign-in', signUpPath: '/api/auth/workos/sign-up', csrfCookieName: csrfCookie, assurance: 'provider' };
  }

  admitted(user) {
    return Boolean(user?.emailVerified && this.invitedEmails.has(String(user.email || '').trim().toLowerCase()));
  }

  async startAuthorization({ screenHint = 'sign-in', returnTo = '/' } = {}) {
    const result = await this.workos.userManagement.getAuthorizationUrlWithPKCE({
      clientId: this.clientId,
      provider: 'authkit',
      redirectUri: this.redirectUri,
      screenHint
    });
    const flow = {
      stateHash: hash(result.state),
      codeVerifier: result.codeVerifier,
      returnTo: safeReturnPath(returnTo),
      createdAt: this.store.now(),
      expiresAt: new Date(Date.now() + flowMinutes * 60_000).toISOString(),
      usedAt: null
    };
    await this.store.putJson(path.join('auth', 'workos-flows', `${flow.stateHash}.json`), flow);
    return { url: result.url };
  }

  async completeAuthorization({ code, state, ipAddress, userAgent }) {
    if (!code || !state) throw Object.assign(new Error('Authorization code and state are required'), { statusCode: 400 });
    const relative = path.join('auth', 'workos-flows', `${hash(state)}.json`);
    const pending = await this.store.getJson(relative);
    const flow = pending && !pending.usedAt && new Date(pending.expiresAt) > new Date()
      ? await this.store.claimJson(relative, 'usedAt', this.store.now())
      : null;
    if (!flow) throw Object.assign(new Error('Authentication flow is invalid, expired, or already used'), { statusCode: 401 });
    const authentication = await this.workos.userManagement.authenticateWithCode({
      clientId: this.clientId,
      code,
      codeVerifier: flow.codeVerifier,
      ipAddress,
      userAgent,
      session: { sealSession: true, cookiePassword: this.cookiePassword }
    });
    if (!authentication.sealedSession) throw Object.assign(new Error('Authentication provider did not return a sealed session'), { statusCode: 502 });
    if (!this.admitted(authentication.user)) throw Object.assign(new Error('Invited, verified WorkOS account required'), { statusCode: 403 });
    const human = await this.upsertHuman(authentication.user);
    return { human: publicHuman(human), sealedSession: authentication.sealedSession, returnTo: flow.returnTo };
  }

  async upsertHuman(user) {
    const indexPath = path.join('auth', 'workos-user-index', `${encodeURIComponent(user.id)}.json`);
    const index = await this.store.getJson(indexPath);
    const existing = index ? await this.store.getJson(path.join('humans', `${index.humanId}.json`)) : null;
    const now = this.store.now();
    const emailVerified = Boolean(user.emailVerified);
    const previouslyVerified = Boolean(existing?.emailVerified && existing?.verifiedAt);
    const human = {
      ...(existing || { id: this.store.id('human'), createdAt: this.store.now() }),
      workosUserId: user.id,
      email: user.email,
      emailVerified: emailVerified || previouslyVerified,
      displayName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      authProvider: 'workos',
      verifiedAt: emailVerified ? (existing?.verifiedAt || now) : (previouslyVerified ? existing.verifiedAt : null),
      updatedAt: now
    };
    await this.store.putJson(path.join('humans', `${human.id}.json`), human);
    await this.store.putJson(indexPath, { humanId: human.id });
    return human;
  }

  async getProviderSession(req) {
    const sealedSession = parseCookies(req.headers.cookie)[sessionCookie];
    if (!sealedSession) return null;
    const session = this.workos.userManagement.loadSealedSession({ sessionData: sealedSession, cookiePassword: this.cookiePassword });
    const result = await session.authenticate();
    return result.authenticated ? { ...result, sealedSession } : null;
  }

  async getSession(req) {
    const session = await this.getProviderSession(req);
    if (!session || !this.admitted(session.user)) return null;
    return { ...session, assurance: 'provider' };
  }

  async getHuman(req) {
    if (req[requestHuman]) return req[requestHuman];
    const pending = (async () => {
      const session = await this.getSession(req);
      if (!session) return null;
      const human = await this.upsertHuman(session.user);
      return { ...publicHuman(human), providerUserId: session.user.id, organizationId: session.organizationId || null, role: session.role || null, permissions: session.permissions || [] };
    })();
    Object.defineProperty(req, requestHuman, { value: pending, enumerable: false });
    return pending;
  }

  async getOrganizationMembership(userId, organizationId) {
    if (!userId || !organizationId) return null;
    const result = await this.workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId,
      statuses: ['active'],
      limit: 10
    });
    return result.data.find(membership => membership.userId === userId
      && membership.organizationId === organizationId
      && membership.status === 'active') || null;
  }

  async logout(req) {
    const sessionData = parseCookies(req.headers.cookie)[sessionCookie];
    if (!sessionData) return { revoked: false, logoutUrl: null };
    const session = this.workos.userManagement.loadSealedSession({ sessionData, cookiePassword: this.cookiePassword });
    const logoutUrl = await session.getLogoutUrl({ returnTo: process.env.SINALOA_PUBLIC_URL || new URL(this.redirectUri).origin });
    return { revoked: true, logoutUrl };
  }

  async createProviderOrganization({ name, externalId, idempotencyKey, userId }) {
    const organization = await this.workos.organizations.createOrganization(
      { name, externalId, metadata: { product: 'sinaloa' } },
      { idempotencyKey }
    );
    await this.workos.userManagement.createOrganizationMembership({ organizationId: organization.id, userId, roleSlug: 'admin' });
    return organization;
  }
}
