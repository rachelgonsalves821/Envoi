import crypto from 'node:crypto';

// agent-registration v1 (task A-4.2): codes, tokens and names (handoffs.md "## agent-registration v1"
// §2, §3, §6.2; schemas.json x-limits and definitions). Pure functions; nothing here touches storage.

// §2 verification code: 8 symbols from the Crockford alphabet (40 bits), shown as XXXX-XXXX.
export const verificationAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const codeSymbols = 8;
const typedCodeMaxLength = 32; // definitions.typedCode maxLength

// One crypto.randomInt(32) per symbol, so every symbol is uniform and independent.
export function generateVerificationCode() {
  let normalized = '';
  for (let index = 0; index < codeSymbols; index += 1) normalized += verificationAlphabet[crypto.randomInt(verificationAlphabet.length)];
  return { normalized, display: displayVerificationCode(normalized) };
}

// §2 typing rules: case-insensitive, spaces and hyphens ignored, I/L read as 1 and O as 0.
// Only ASCII letters are upper-cased, so e.g. "ß" never becomes "SS" and "ı" never becomes "I".
export function normalizeVerificationCode(value) {
  if (typeof value !== 'string' || value.length > typedCodeMaxLength) return null;
  const normalized = value
    .replace(/[ -]/g, '')
    .replace(/[a-z]/g, letter => letter.toUpperCase())
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (normalized.length !== codeSymbols) return null;
  for (const symbol of normalized) if (!verificationAlphabet.includes(symbol)) return null;
  return normalized;
}

export const displayVerificationCode = normalized => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

// §2: codes are stored only as HMAC-SHA256 under a key derived from ENVOI_DATA_ENCRYPTION_KEY.
export const verificationCodeKey = dataKeyBuffer => Buffer.from(crypto.hkdfSync('sha256', dataKeyBuffer, Buffer.alloc(0), Buffer.from('envoi-agent-registration-code-v1'), 32));
export const verificationCodeHmac = (normalized, key) => crypto.createHmac('sha256', key).update(normalized).digest('hex');

// §2 bootstrap token: envoi_reg_ + 32 random bytes, base64url (43 characters); stored as SHA-256.
export const generateBootstrapToken = () => `envoi_reg_${crypto.randomBytes(32).toString('base64url')}`;
export const isBootstrapToken = raw => typeof raw === 'string' && /^envoi_reg_[A-Za-z0-9_-]{43}$/.test(raw);
export const hashToken = raw => crypto.createHash('sha256').update(raw).digest('hex');

// definitions.activationId (§6.1), the same shape as A1's rotationId.
export const validActivationId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);

// The two `not.pattern`s of definitions.registrationCreateRequest.properties.requestedName
// (also definitions.displayName). The test asserts each `.source` equals the schema string.
export const tokenLikePattern = /(?:(?:envoi|sinaloa)_agent_(?:access|refresh)_|(?:envoi|sinaloa)_mcp_read_|(?:envoi|sinaloa)_enroll_|envoi_reg_)/;
export const unsafeNameCharacters = /[\u0000-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
const nameMaxLength = 80; // counted in code points, as JSON Schema counts maxLength
const unsafeNameCharactersGlobal = new RegExp(unsafeNameCharacters.source, 'g');
// A token-like prefix plus the token-ish run after it, so no part of the secret survives.
const tokenLikeRunGlobal = new RegExp(`${tokenLikePattern.source}[A-Za-z0-9_-]*`, 'g');

// §3 requestedName: 1–80 characters; control, zero-width and bidi formatting characters refused.
export function validRequestedName(value) {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= 1 && length <= nameMaxLength && !unsafeNameCharacters.test(value) && !tokenLikePattern.test(value);
}

// §3 "Names and addresses in responses": every returned agent or workspace name, in the
// contract's order: remove unsafe characters, redact token-like substrings, truncate to 80
// (79 plus "…"), and fall back to the address local part when nothing is left. Whitespace is
// trimmed before truncating (so it does not use up the 80) and again after.
export function displayName(value, fallbackLocalPart) {
  if (typeof value !== 'string') return fallbackLocalPart;
  const cleaned = value.replace(unsafeNameCharactersGlobal, '').replace(tokenLikeRunGlobal, '[redacted]').trim();
  const points = [...cleaned];
  const bounded = points.length > nameMaxLength ? `${points.slice(0, nameMaxLength - 1).join('')}…` : cleaned;
  return bounded.trim() || fallbackLocalPart;
}

// §4 approverEmailHint: first character of the verified email's local part, ***, then the full
// domain, lower-cased (e.g. o***@example.com). null when no hint matching the schema can be made.
export function approverEmailHint(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const [first] = email.slice(0, at);
  if (first === '@' || first === '*' || /^\s$/u.test(first)) return null;
  // One code point, even when lower-casing expands it (U+0130 becomes "i" plus a combining dot).
  const [initial] = first.toLowerCase();
  const hint = `${initial}***@${domain}`;
  return hint.length <= 260 ? hint : null;
}

// §6.2 activation recovery envelope, mirroring A1's rotationRecoveryKey/rotationRecoveryContext.
// Key: HKDF-SHA256(ikm = raw bootstrap token, salt = SHA-256 of ENVOI_DATA_ENCRYPTION_KEY, which the
// caller passes in, info = envoi-agent-activation-recovery-v1). The registration id and the SHA-256
// of the activationId are AES-GCM additional data, so an envelope cannot move to another
// registration or activation, and a database read plus the server key cannot decrypt it.
export const activationRecoveryKey = (rawBootstrapToken, saltBuffer) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(rawBootstrapToken), saltBuffer, Buffer.from('envoi-agent-activation-recovery-v1'), 32));
const activationRecoveryContext = (registrationId, activationIdHash) => Buffer.from(`${registrationId}:${activationIdHash}`);

export function encryptActivation(rawBootstrapToken, saltBuffer, registrationId, activationIdHash, body) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', activationRecoveryKey(rawBootstrapToken, saltBuffer), iv, { authTagLength: 16 });
  cipher.setAAD(activationRecoveryContext(registrationId, activationIdHash));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

// Returns the stored body, or null on any failure (wrong token, binding, tampering or shape). Never throws.
export function decryptActivation(rawBootstrapToken, saltBuffer, registrationId, activationIdHash, encrypted) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', activationRecoveryKey(rawBootstrapToken, saltBuffer), Buffer.from(encrypted.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(activationRecoveryContext(registrationId, activationIdHash));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { return null; }
}
