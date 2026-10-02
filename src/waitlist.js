import crypto from 'node:crypto';
import path from 'node:path';

export function normalizeWaitlistEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) return null;
  return email;
}

export async function joinWaitlist(store, input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') return { error: 'Enter a valid email address' };
  const email = normalizeWaitlistEmail(input.email);
  if (!email) return { error: 'Enter a valid email address' };
  if (input.company) return { accepted: true };
  const digest = crypto.createHash('sha256').update(email).digest('hex');
  const created = await store.putJsonIfAbsent(path.join('waitlist', `${digest}.json`), {
    email,
    source: 'landing',
    createdAt: new Date().toISOString()
  });
  return { accepted: true, created };
}
