import crypto from 'node:crypto';
import path from 'node:path';
import { generateSecret, generateURI, verifySync } from 'otplib';

const mode = process.env.SINALOA_AUTH_MODE || 'development';
const challengeMinutes = Number(process.env.SINALOA_OTP_EXPIRY_MINUTES || 10);
const sessionHours = Number(process.env.SINALOA_SESSION_HOURS || 24);

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const normalizePhone = value => {
  const phone = String(value || '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error('Phone number must use E.164 format, for example +14165551234'), { statusCode: 400 });
  return phone;
};
const twilioConfigured = () => Boolean(process.env.SINALOA_TWILIO_ACCOUNT_SID && process.env.SINALOA_TWILIO_AUTH_TOKEN && process.env.SINALOA_TWILIO_VERIFY_SERVICE_SID);
const encryptionKey = () => {
  const configured = process.env.SINALOA_DATA_ENCRYPTION_KEY;
  if (mode === 'production' && !configured) throw Object.assign(new Error('Data encryption key is not configured'), { statusCode: 503 });
  return crypto.createHash('sha256').update(configured || 'sinaloa-development-only').digest();
};
const lookupHash = value => crypto.createHmac('sha256', encryptionKey()).update(value).digest('hex');
const encrypt = value => { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }; };
const decrypt = value => { const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'); };
const publicHuman = human => { const value = { ...human }; delete value.totpSecret; delete value.pendingTotpSecret; delete value.phoneHash; return value; };

async function twilioRequest(pathname, params) {
  const auth = Buffer.from(`${process.env.SINALOA_TWILIO_ACCOUNT_SID}:${process.env.SINALOA_TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(`https://verify.twilio.com/v2/Services/${process.env.SINALOA_TWILIO_VERIFY_SERVICE_SID}${pathname}`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  if (!response.ok) throw Object.assign(new Error('Phone verification provider request failed'), { statusCode: 502 });
  return response.json();
}

export class AuthService {
  constructor(store) { this.store = store; }

  async startPhoneVerification(phoneInput, displayName) {
    const phone = normalizePhone(phoneInput);
    if (mode === 'production' && !twilioConfigured()) throw Object.assign(new Error('Phone verification is not configured'), { statusCode: 503 });
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
    const challenge = { id: challengeId, phoneEncrypted: encrypt(phone), phoneHash, phoneLast4: phone.slice(-4), displayName: displayName || null, expiresAt: new Date(Date.now() + challengeMinutes * 60_000).toISOString(), attempts: 0, status: 'pending', provider: twilioConfigured() ? 'twilio-verify' : 'development' };
    let developmentCode;
    if (twilioConfigured()) await twilioRequest('/Verifications', { To: phone, Channel: 'sms' });
    else { developmentCode = String(crypto.randomInt(100000, 1000000)); challenge.codeHash = hash(developmentCode); }
    await this.store.putJson(path.join('auth', 'challenges', `${challengeId}.json`), challenge);
    return { challengeId, expiresAt: challenge.expiresAt, delivery: challenge.provider, ...(mode === 'development' && developmentCode ? { developmentCode } : {}) };
  }

  async verifyPhone(challengeId, code) {
    const relative = path.join('auth', 'challenges', `${challengeId}.json`);
    const challenge = await this.store.getJson(relative);
    if (!challenge || challenge.status !== 'pending') throw Object.assign(new Error('Verification challenge is invalid'), { statusCode: 400 });
    if (new Date(challenge.expiresAt) < new Date()) throw Object.assign(new Error('Verification challenge has expired'), { statusCode: 400 });
    challenge.attempts += 1;
    if (challenge.attempts > 5) { challenge.status = 'locked'; await this.store.putJson(relative, challenge); throw Object.assign(new Error('Too many verification attempts'), { statusCode: 429 }); }
    let approved = false;
    if (challenge.provider === 'twilio-verify') {
      const result = await twilioRequest('/VerificationCheck', { To: decrypt(challenge.phoneEncrypted), Code: code });
      approved = result.status === 'approved';
    } else approved = hash(String(code)) === challenge.codeHash;
    if (!approved) { await this.store.putJson(relative, challenge); throw Object.assign(new Error('Incorrect verification code'), { statusCode: 401 }); }
    challenge.status = 'verified'; await this.store.putJson(relative, challenge);
    const index = await this.store.getJson(path.join('auth', 'phone-index', `${challenge.phoneHash}.json`));
    const existing = index ? await this.store.getJson(path.join('humans', `${index.humanId}.json`)) : null;
    const human = existing || { id: this.store.id('human'), phoneHash: challenge.phoneHash, phoneLast4: challenge.phoneLast4, displayName: challenge.displayName, createdAt: this.store.now() };
    human.verifiedAt = this.store.now();
    await this.store.putJson(path.join('humans', `${human.id}.json`), human);
    await this.store.putJson(path.join('auth', 'phone-index', `${challenge.phoneHash}.json`), { humanId: human.id });
    delete challenge.phoneEncrypted;
    await this.store.putJson(relative, challenge);
    const sessionToken = token();
    const session = { id: this.store.id('session'), tokenHash: hash(sessionToken), humanId: human.id, assurance: 'phone', createdAt: this.store.now(), expiresAt: new Date(Date.now() + sessionHours * 3_600_000).toISOString() };
    await this.store.putJson(path.join('auth', 'sessions', `${session.tokenHash}.json`), session);
    return { human: publicHuman(human), sessionToken, expiresAt: session.expiresAt, secondFactorRequired: true };
  }

  async getSession(req) {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) return null;
    const session = await this.store.getJson(path.join('auth', 'sessions', `${hash(raw)}.json`));
    if (session && new Date(session.expiresAt) <= new Date()) return null;
    return session;
  }

  async getHuman(req, { requireMfa = true } = {}) {
    const session = await this.getSession(req);
    if (!session || (requireMfa && session.assurance !== 'mfa')) return null;
    const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
    return human ? publicHuman(human) : null;
  }

  async startTotp(req) {
    const session = await this.getSession(req);
    if (!session) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
    const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
    if (human.mfaEnabledAt && session.assurance !== 'mfa') throw Object.assign(new Error('Existing second factor must be verified before replacement'), { statusCode: 403 });
    const secret = generateSecret();
    human.pendingTotpSecret = encrypt(secret);
    await this.store.putJson(path.join('humans', `${human.id}.json`), human);
    return { secret, otpauthUri: generateURI({ issuer: 'Sinaloa', label: human.displayName || human.id, secret }) };
  }

  async verifyTotp(req, code) {
    const session = await this.getSession(req);
    if (!session) throw Object.assign(new Error('Verified phone session required'), { statusCode: 401 });
    const human = await this.store.getJson(path.join('humans', `${session.humanId}.json`));
    const encrypted = human.pendingTotpSecret || human.totpSecret;
    if (!encrypted) throw Object.assign(new Error('TOTP setup has not been started'), { statusCode: 400 });
    const result = verifySync({ token: String(code), secret: decrypt(encrypted), epochTolerance: 1 });
    if (!result.valid) throw Object.assign(new Error('Incorrect authenticator code'), { statusCode: 401 });
    if (human.lastTotpTimeStep != null && result.timeStep <= human.lastTotpTimeStep) throw Object.assign(new Error('Authenticator code has already been used'), { statusCode: 401 });
    human.totpSecret = encrypted;
    delete human.pendingTotpSecret;
    human.mfaEnabledAt = this.store.now();
    human.lastTotpTimeStep = result.timeStep;
    session.assurance = 'mfa';
    session.mfaVerifiedAt = this.store.now();
    await this.store.putJson(path.join('humans', `${human.id}.json`), human);
    await this.store.putJson(path.join('auth', 'sessions', `${session.tokenHash}.json`), session);
    return { human: publicHuman(human), assurance: session.assurance };
  }

  async logout(req) {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) return false;
    return this.store.deleteJson(path.join('auth', 'sessions', `${hash(raw)}.json`));
  }
}
