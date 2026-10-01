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
const requestSession = Symbol('workos-request-session');
const requestResponse = Symbol('workos-request-response');
const requestCookie = Symbol('workos-request-cookie');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tokenClaims = accessToken => {
  try {
    const claims = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString());
    return { sessionId: typeof claims.sid === 'string' ? claims.sid : null, issuedAt: Number(claims.iat) * 1000, expiresAt: Number(claims.exp) * 1000 };
  } catch { return {}; }
};
const unavailable = () => Object.assign(new Error('Authentication is temporarily unavailable. Please try again.'), { statusCode: 503, code: 'auth_unavailable' });
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
  return Object.fromEntries(header.split(';').map(value => value.trim()).filter(Boolean).flatMap(value => {
    const separator = value.indexOf('=');
    if (separator < 0) return [[value, '']];
    try {
      return [[value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))]];
    } catch {
      return [];
    }
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
    this.now = options.now || Date.now;
    this.sessionHours = Number(options.sessionHours ?? process.env.SINALOA_SESSION_HOURS ?? 24);
    if (!Number.isFinite(this.sessionHours) || this.sessionHours <= 0) throw new Error('Session duration must be positive');
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
    const claims = tokenClaims(authentication.accessToken);
    if (claims.sessionId) await this.recordSession({ sessionId: claims.sessionId, accessToken: authentication.accessToken }, this.now());
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

  bindResponse(req, res) {
    if (req[requestResponse]) return;
    req[requestResponse] = res;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      // Apply at the final header boundary so route-level cookie updates survive.
      const pending = req[requestCookie];
      if (pending && !this.headersSent) {
        const existing = this.getHeader('Set-Cookie');
        const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
        const headerIndex = typeof args[1] === 'string' ? 2 : 1;
        const headers = args[headerIndex];
        if (headers && !Array.isArray(headers)) {
          args[headerIndex] = { ...headers };
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() !== 'set-cookie') continue;
            const values = headers[name];
            cookies.push(...(Array.isArray(values) ? values : [values]));
            delete args[headerIndex][name];
          }
        }
        const clearing = /(?:^|;\s*)Max-Age=0(?:;|$)/.test(pending);
        this.setHeader('Set-Cookie', [
          ...cookies.filter(value => !String(value).startsWith(`${sessionCookie}=`) && (!clearing || !String(value).startsWith(`${csrfCookie}=`))),
          pending,
          ...(clearing ? [csrfCookieHeader('', { clear: true })] : [])
        ]);
      }
      return writeHead.apply(this, args);
    };
  }

  queueSessionCookie(req, sealedSession = null) {
    req[requestCookie] = sessionCookieHeader(sealedSession || '', { clear: !sealedSession });
  }

  sessionPath(sessionId) { return path.join('auth', 'workos-sessions', `${hash(sessionId)}.json`); }
  sessionKey(sessionId) { return `workos-session:${hash(sessionId)}`; }

  async recordSession(session, issuedAt = null) {
    if (!session?.sessionId) return null;
    return this.store.withTransaction([this.sessionKey(session.sessionId)], async () => {
      const relative = this.sessionPath(session.sessionId);
      const existing = await this.store.getJson(relative);
      if (existing?.revokedAt) return null;
      const claims = tokenClaims(session.accessToken || session.session?.accessToken);
      const initial = existing?.issuedAt ?? issuedAt ?? (Number.isFinite(claims.issuedAt) ? claims.issuedAt : this.now());
      const maximum = existing?.sessionExpiresAt ?? initial + this.sessionHours * 3_600_000;
      if (maximum <= this.now()) return null;
      const tokenExpiry = Number.isFinite(claims.expiresAt) ? claims.expiresAt : maximum;
      const accessExpiresAt = Math.min(maximum, Math.max(existing?.accessExpiresAt || 0, tokenExpiry));
      const replays = (existing?.replays || []).filter(replay => replay.expiresAt > this.now());
      const record = { sessionId: session.sessionId, issuedAt: initial, sessionExpiresAt: maximum, accessExpiresAt, revokedAt: null, replays };
      await this.store.putJson(relative, record);
      return { ...session, expiresAt: new Date(Math.min(tokenExpiry, maximum)).toISOString() };
    });
  }

  async isSessionActive(session) {
    if (!session?.sessionId) return false;
    const record = await this.store.getJson(this.sessionPath(session.sessionId));
    return Boolean(record && !record.revokedAt && record.sessionExpiresAt > this.now() && record.accessExpiresAt > this.now());
  }

  async captureSessionLease(req) {
    const session = await this.getSession(req);
    return session ? { sessionId: session.sessionId, expiresAt: session.expiresAt } : null;
  }

  async validateSessionLease(lease) { return this.isSessionActive(lease); }

  async getProviderSession(req) {
    if (!req[requestSession]) Object.defineProperty(req, requestSession, { value: this.resolveProviderSession(req), enumerable: false });
    return req[requestSession];
  }

  async resolveProviderSession(req) {
    const sealedSession = parseCookies(req.headers.cookie)[sessionCookie];
    if (!sealedSession) return null;
    const provider = this.workos.userManagement;
    const session = provider.loadSealedSession({ sessionData: sealedSession, cookiePassword: this.cookiePassword });
    let result;
    try { result = await session.authenticate(); }
    catch { throw unavailable(); }
    if (result.authenticated) {
      const recorded = await this.recordSession({ ...result, sealedSession });
      if (!recorded || !await this.isSessionActive(recorded)) { this.queueSessionCookie(req); return null; }
      return recorded;
    }
    if (result.reason !== 'invalid_jwt') { this.queueSessionCookie(req); return null; }
    // Only inspect claims after the SDK has verified the encrypted cookie's seal.
    // These claims select the revocation record; they never authorize a request.
    let data;
    try { data = await provider.getSessionFromCookie({ sessionData: sealedSession, cookiePassword: this.cookiePassword }); }
    catch { this.queueSessionCookie(req); return null; }
    const claims = tokenClaims(data?.accessToken);
    if (!claims.sessionId || !data?.refreshToken) { this.queueSessionCookie(req); return null; }
    const refreshed = await this.store.withTransaction([this.sessionKey(claims.sessionId)], async () => {
      const relative = this.sessionPath(claims.sessionId);
      const lifecycle = await this.store.getJson(relative);
      const issuedAt = lifecycle?.issuedAt ?? (Number.isFinite(claims.issuedAt) ? claims.issuedAt : this.now());
      if (lifecycle?.revokedAt || (lifecycle?.sessionExpiresAt ?? issuedAt + this.sessionHours * 3_600_000) <= this.now()) return null;
      const cookieHash = hash(sealedSession);
      const replay = lifecycle?.replays?.find(value => value.cookieHash === cookieHash && value.expiresAt > this.now());
      let renewed;
      if (replay && replay.expiresAt > this.now()) {
        renewed = { authenticated: true, sealedSession: replay.sealedSession };
      } else {
        try { renewed = await session.refresh(); }
        catch { throw unavailable(); }
      }
      if (!renewed.authenticated) {
        if (renewed.retryable || ['rate_limit_exceeded', 'timeout', 'server_error', 'network_error'].includes(renewed.reason)) throw unavailable();
        await this.store.putJson(relative, { ...lifecycle, sessionId: claims.sessionId, revokedAt: new Date(this.now()).toISOString(), replays: [] });
        return null;
      }
      if (!renewed.sealedSession) throw unavailable();
      let verified;
      try { verified = await provider.loadSealedSession({ sessionData: renewed.sealedSession, cookiePassword: this.cookiePassword }).authenticate(); }
      catch { throw unavailable(); }
      if (!verified.authenticated || verified.sessionId !== claims.sessionId) throw unavailable();
      const recorded = await this.recordSession({ ...verified, sealedSession: renewed.sealedSession }, issuedAt);
      if (!recorded) return null;
      // WorkOS rotation permits a short replay window. Share the sealed replacement
      // across instances so concurrent requests do not rotate the token repeatedly.
      if (!replay || replay.expiresAt <= this.now()) {
        const current = await this.store.getJson(relative);
        const replays = [...current.replays, { cookieHash, sealedSession: renewed.sealedSession, expiresAt: this.now() + 30_000 }].slice(-4);
        await this.store.putJson(relative, { ...current, replays });
      }
      return recorded;
    });
    if (!refreshed || !await this.isSessionActive(refreshed)) { this.queueSessionCookie(req); return null; }
    this.queueSessionCookie(req, refreshed.sealedSession);
    return refreshed;
  }

  async getSession(req) {
    const session = await this.getProviderSession(req);
    if (!session) return null;
    if (!this.admitted(session.user) || !await this.isSessionActive(session)) {
      this.queueSessionCookie(req);
      return null;
    }
    return { ...session, assurance: 'provider' };
  }

  async getHuman(req) {
    if (req[requestHuman]) return req[requestHuman];
    const pending = (async () => {
      const session = await this.getSession(req);
      if (!session) return null;
      const human = await this.upsertHuman(session.user);
      if (!await this.isSessionActive(session)) return null;
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

  async logout(req, { onRevoked } = {}) {
    const sessionData = parseCookies(req.headers.cookie)[sessionCookie];
    this.queueSessionCookie(req);
    if (!sessionData) return { revoked: false, logoutUrl: null };
    const provider = this.workos.userManagement;
    let sessionId;
    if (provider.getSessionFromCookie) {
      try {
        const data = await provider.getSessionFromCookie({ sessionData, cookiePassword: this.cookiePassword });
        sessionId = tokenClaims(data?.accessToken).sessionId;
      } catch { return { revoked: false, logoutUrl: null }; }
    } else {
      // Compatibility for injected providers; production SDK exposes safe unsealing.
      const session = await this.getProviderSession(req);
      sessionId = session?.sessionId;
    }
    if (!sessionId) return { revoked: false, logoutUrl: null };
    await this.store.withTransaction([this.sessionKey(sessionId)], async () => {
      const relative = this.sessionPath(sessionId);
      const existing = await this.store.getJson(relative);
      await this.store.putJson(relative, { ...existing, sessionId, revokedAt: new Date(this.now()).toISOString(), replays: [] });
    });
    // Disconnect local live streams as soon as the durable deny is committed,
    // before provider network calls can delay completion of the logout response.
    if (onRevoked) onRevoked(sessionId);
    let providerRevoked = false;
    if (provider.revokeSession) {
      try { await provider.revokeSession({ sessionId }); providerRevoked = true; }
      catch { /* Durable local revocation remains authoritative during outages. */ }
    }
    const returnTo = process.env.SINALOA_PUBLIC_URL || new URL(this.redirectUri).origin;
    let logoutUrl = null;
    try {
      logoutUrl = provider.getLogoutUrl
        ? await provider.getLogoutUrl({ sessionId, returnTo })
        : await provider.loadSealedSession({ sessionData, cookiePassword: this.cookiePassword }).getLogoutUrl({ returnTo });
    } catch { /* Signing out locally must not depend on provider availability. */ }
    return { revoked: true, logoutUrl, sessionId, providerRevoked };
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
