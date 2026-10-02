import crypto from 'node:crypto';
import path from 'node:path';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import { csrfCookieHeader, parseCookies, sessionCookieHeader, sessionCookieName } from './workos-auth.js';

const mode = process.env.SINALOA_AUTH_MODE || 'development';
const challengeMinutes = Number(process.env.SINALOA_OTP_EXPIRY_MINUTES || 10);
const sessionHours = Number(process.env.SINALOA_SESSION_HOURS || 24);
const requestResponse = Symbol('local-auth-response');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const normalizePhone = value => {
  const phone = String(value || '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error('Phone number must use E.164 format, for example +14165551234'), { statusCode: 400 });
  return phone;
};
const encryptionKey = () => {
  const configured = process.env.SINALOA_DATA_ENCRYPTION_KEY;
  if (mode === 'production' && !configured) throw Object.assign(new Error('Data encryption key is not configured'), { statusCode: 503 });
  return crypto.createHash('sha256').update(configured || 'sinaloa-development-only').digest();
};
const lookupHash = value => crypto.createHmac('sha256', encryptionKey()).update(value).digest('hex');
const encrypt = value => { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }; };
const decrypt = value => { const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'); };
const publicHuman = human => { const value = { ...human }; delete value.totpSecret; delete value.pendingTotpSecret; delete value.phoneHash; return value; };
const mfaEnrollmentState = human => {
  const hasSecret = Boolean(human?.totpSecret);
  const hasEnabledAt = Boolean(human?.mfaEnabledAt);
  if (hasSecret !== hasEnabledAt) throw Object.assign(new Error('Second-factor enrollment state requires administrator recovery'), { statusCode: 503 });
  return { enrolled: hasSecret, setupRequired: !hasSecret };
};
const expectedError = (statusCode, message) => ({ error: { statusCode, message } });
const throwExpectedError = result => {
  if (result?.error) throw Object.assign(new Error(result.error.message), { statusCode: result.error.statusCode });
  return result.value;
};

export class AuthService {
  constructor(store) { this.store = store; }

  bindResponse(req, res) { req[requestResponse] = res; }

  async startPhoneVerification(phoneInput, displayName) {
    if (mode !== 'development') throw Object.assign(new Error('Local phone verification is disabled'), { statusCode: 404 });
    const phone = normalizePhone(phoneInput);
    const phoneHash = lookupHash(phone);
    const ratePath = path.join('auth', 'phone-rate-limits', `${phoneHash}.json`);
    const now = Date.now();
    const rate = await this.store.getJson(ratePath, { starts: [] });
    rate.starts = rate.starts.filter(timestamp => now - new Date(timestamp).getTime() < 3_600_000);
    if (rate.starts.length && now - new Date(rate.starts.at(-1)).getTime() < 60_000) throw Object.assign(new Error('Please wait before requesting another verification code'), { statusCode: 429 });
    if (rate.starts.length >= 5) throw Object.assign(new Error('Phone verification request limit exceeded'), { statusCode: 429 });
    rate.starts.push(new Date(now).toISOString());
    await this.store.putJson(ratePath, rate);
    const challengeId = this.store.id('challenge');
    const challenge = { id: challengeId, phoneHash, phoneLast4: phone.slice(-4), displayName: displayName || null, expiresAt: new Date(Date.now() + challengeMinutes * 60_000).toISOString(), attempts: 0, status: 'pending', provider: 'development' };
    const developmentCode = String(crypto.randomInt(100000, 1000000));
    challenge.codeHash = hash(developmentCode);
    await this.store.putJson(path.join('auth', 'challenges', `${challengeId}.json`), challenge);
    return { challengeId, expiresAt: challenge.expiresAt, delivery: challenge.provider, ...(mode === 'development' && developmentCode ? { developmentCode } : {}) };
  }

  async verifyPhone(challengeId, code) {
    if (mode !== 'development') throw Object.assign(new Error('Local phone verification is disabled'), { statusCode: 404 });
    const relative = path.join('auth', 'challenges', `${challengeId}.json`);
    const pending = await this.store.getJson(relative);
    if (!pending?.phoneHash) throw Object.assign(new Error('Verification challenge is invalid'), { statusCode: 400 });
    const verify = async () => {
      const challenge = await this.store.getJson(relative);
      if (!challenge || challenge.status !== 'pending') return expectedError(400, 'Verification challenge is invalid');
      if (new Date(challenge.expiresAt) < new Date()) {
        challenge.status = 'expired';
        delete challenge.codeHash;
        await this.store.putJson(relative, challenge);
        return expectedError(400, 'Verification challenge has expired');
      }
      challenge.attempts += 1;
      if (challenge.attempts > 5) {
        challenge.status = 'locked';
        delete challenge.codeHash;
        await this.store.putJson(relative, challenge);
        return expectedError(429, 'Too many verification attempts');
      }
      const approved = hash(String(code)) === challenge.codeHash;
      if (!approved) {
        await this.store.putJson(relative, challenge);
        return expectedError(401, 'Incorrect verification code');
      }
      const index = await this.store.getJson(path.join('auth', 'phone-index', `${challenge.phoneHash}.json`));
      const existing = index ? await this.store.getJson(path.join('humans', `${index.humanId}.json`)) : null;
      const human = existing || { id: this.store.id('human'), phoneHash: challenge.phoneHash, phoneLast4: challenge.phoneLast4, displayName: challenge.displayName, createdAt: this.store.now() };
      const { setupRequired: mfaSetupRequired } = mfaEnrollmentState(human);
      const verifiedAt = this.store.now();
      human.verifiedAt = verifiedAt;
      challenge.status = 'verified';
      challenge.verifiedAt = verifiedAt;
      delete challenge.codeHash;
      const sessionToken = token();
      const session = { id: this.store.id('session'), tokenHash: hash(sessionToken), humanId: human.id, assurance: 'phone', mfaSetupRequired, createdAt: verifiedAt, expiresAt: new Date(Date.now() + sessionHours * 3_600_000).toISOString() };
      await this.store.putJsonBatch([
        { path: path.join('humans', `${human.id}.json`), value: human },
        { path: path.join('auth', 'phone-index', `${challenge.phoneHash}.json`), value: { humanId: human.id } },
        { path: relative, value: challenge },
        { path: path.join('auth', 'sessions', `${session.tokenHash}.json`), value: session }
      ]);
      return { value: { human: publicHuman(human), sessionCookieValue: sessionToken, expiresAt: session.expiresAt, secondFactorRequired: true, mfaSetupRequired } };
    };
    const result = typeof this.store.withTransaction === 'function'
      ? await this.store.withTransaction([`auth:phone:${pending.phoneHash}`, `auth:phone-challenge:${challengeId}`], verify)
      : await verify();
    return throwExpectedError(result);
  }

  async getSession(req) {
    const raw = parseCookies(req.headers.cookie)[sessionCookieName()] || null;
    if (!raw) return null;
    const session = await this.store.getJson(path.join('auth', 'sessions', `${hash(raw)}.json`));
    if (!session || new Date(session.expiresAt) <= new Date()) {
      const res = req[requestResponse];
      if (res && !res.headersSent) res.setHeader('set-cookie', [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true })]);
      return null;
    }
    return session;
  }

  async getHuman(req, { requireMfa = true } = {}) {
    const session = await this.getSession(req);
    if (!session || (requireMfa && session.assurance !== 'mfa')) return null;
    const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
    return human ? publicHuman(human) : null;
  }

  async getMfaSetupRequired(req) {
    const session = await this.getSession(req);
    if (!session || session.assurance !== 'phone') return null;
    const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
    if (!human) throw Object.assign(new Error('Verified human account required'), { statusCode: 401 });
    return mfaEnrollmentState(human).setupRequired;
  }

  async startTotp(req) {
    const pendingSession = await this.getSession(req);
    if (!pendingSession) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
    const setup = async () => {
      const session = await this.getSession(req);
      if (!session || session.humanId !== pendingSession.humanId) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
      const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
      if (!human) throw Object.assign(new Error('Verified human account required'), { statusCode: 401 });
      const { enrolled } = mfaEnrollmentState(human);
      if (enrolled && session.assurance !== 'mfa') throw Object.assign(new Error('Existing second factor must be verified before replacement'), { statusCode: 403 });
      const secret = human.pendingTotpSecret ? decrypt(human.pendingTotpSecret) : generateSecret();
      if (!human.pendingTotpSecret) {
        human.pendingTotpSecret = encrypt(secret);
        await this.store.putJson(path.join('humans', `${human.id}.json`), human);
      }
      return {
        secret,
        otpauthUri: generateURI({ issuer: 'Envoi', label: human.displayName || human.id, secret }),
        ...(mode === 'development' ? { developmentCode: generateSync({ secret }) } : {})
      };
    };
    return typeof this.store.withTransaction === 'function'
      ? this.store.withTransaction([`auth:human:${pendingSession.humanId}:mfa`], setup)
      : setup();
  }

  async verifyTotp(req, code) {
    const pendingSession = await this.getSession(req);
    if (!pendingSession) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
    const verify = async () => {
      const session = await this.getSession(req);
      if (!session || session.humanId !== pendingSession.humanId) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
      const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
      if (!human) throw Object.assign(new Error('Verified human account required'), { statusCode: 401 });
      const { enrolled } = mfaEnrollmentState(human);
      const completingSetup = !enrolled;
      const completingReplacement = enrolled && session.assurance === 'mfa' && Boolean(human.pendingTotpSecret);
      const encrypted = completingSetup || completingReplacement ? human.pendingTotpSecret : human.totpSecret;
      if (!encrypted) throw Object.assign(new Error('TOTP setup has not been started'), { statusCode: 400 });
      const result = verifySync({ token: String(code), secret: decrypt(encrypted), epochTolerance: 30 });
      if (!result.valid) throw Object.assign(new Error('Incorrect authenticator code'), { statusCode: 401 });
      if (human.lastTotpTimeStep != null && result.timeStep <= human.lastTotpTimeStep) throw Object.assign(new Error('Authenticator code has already been used'), { statusCode: 401 });
      const verifiedAt = this.store.now();
      if (completingSetup || completingReplacement) {
        human.totpSecret = encrypted;
        human.mfaEnabledAt = verifiedAt;
        delete human.pendingTotpSecret;
      } else if (session.assurance === 'phone') {
        delete human.pendingTotpSecret;
      }
      human.lastTotpTimeStep = result.timeStep;
      session.assurance = 'mfa';
      session.mfaSetupRequired = false;
      session.mfaVerifiedAt = verifiedAt;
      await this.store.putJsonBatch([
        { path: path.join('humans', `${human.id}.json`), value: human },
        { path: path.join('auth', 'sessions', `${session.tokenHash}.json`), value: session }
      ]);
      return { human: publicHuman(human), assurance: session.assurance };
    };
    return typeof this.store.withTransaction === 'function'
      ? this.store.withTransaction([`auth:human:${pendingSession.humanId}:mfa`], verify)
      : verify();
  }

  async logout(req) {
    const raw = parseCookies(req.headers.cookie)[sessionCookieName()] || null;
    if (!raw) return false;
    return this.store.deleteJson(path.join('auth', 'sessions', `${hash(raw)}.json`));
  }
}
