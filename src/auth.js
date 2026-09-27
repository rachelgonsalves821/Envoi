import crypto from 'node:crypto';
import path from 'node:path';

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
    const challengeId = this.store.id('challenge');
    const challenge = { id: challengeId, phone, phoneHash: hash(phone), phoneLast4: phone.slice(-4), displayName: displayName || null, expiresAt: new Date(Date.now() + challengeMinutes * 60_000).toISOString(), attempts: 0, status: 'pending', provider: twilioConfigured() ? 'twilio-verify' : 'development' };
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
      const result = await twilioRequest('/VerificationCheck', { To: challenge.phone, Code: code });
      approved = result.status === 'approved';
    } else approved = hash(String(code)) === challenge.codeHash;
    if (!approved) { await this.store.putJson(relative, challenge); throw Object.assign(new Error('Incorrect verification code'), { statusCode: 401 }); }
    challenge.status = 'verified'; await this.store.putJson(relative, challenge);
    const existing = (await this.store.listJson('humans')).find(item => item.phoneHash === challenge.phoneHash);
    const human = existing || { id: this.store.id('human'), phoneHash: challenge.phoneHash, phoneLast4: challenge.phoneLast4, displayName: challenge.displayName, createdAt: this.store.now() };
    human.verifiedAt = this.store.now();
    await this.store.putJson(path.join('humans', `${human.id}.json`), human);
    const sessionToken = token();
    const session = { id: this.store.id('session'), tokenHash: hash(sessionToken), humanId: human.id, createdAt: this.store.now(), expiresAt: new Date(Date.now() + sessionHours * 3_600_000).toISOString() };
    await this.store.putJson(path.join('auth', 'sessions', `${session.id}.json`), session);
    return { human, sessionToken, expiresAt: session.expiresAt };
  }

  async getHuman(req) {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) return null;
    const sessions = await this.store.listJson('auth/sessions');
    const session = sessions.find(item => item.tokenHash === hash(raw) && new Date(item.expiresAt) > new Date());
    if (!session) return null;
    return this.store.getJson(path.join('humans', `${session.humanId}.json`));
  }
}
