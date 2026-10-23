import net from 'node:net';
import path from 'node:path';
import { sourceHmac, sourceKey } from './agent-registration-codes.js';

// agent-registration v1 (task A-4.2): durable creation and claim-failure limits, and the in-memory
// poll interval (handoffs.md "## agent-registration v1" §2; schemas.json x-limits).

const hourMs = 3_600_000;
const registrationTtlMs = 600_000; // x-limits.registrationTtlSeconds
// x-limits.registrationCreate. Each count is a window of creation times.
const creationLimits = { source: { max: 10, windowMs: hourMs }, network: { max: 30, windowMs: hourMs }, wide: { max: 100, windowMs: hourMs } };
// pendingGlobalMax, counted as creations within the claim window: every pending registration was
// created less than registrationTtlSeconds ago, so this is a conservative upper bound on pending.
const globalLimit = { max: 1000, windowMs: registrationTtlMs };
// x-limits.claimFailures.
const claimFailureLimit = { max: 5, windowMs: 900_000 };

const creationDirectory = path.join('rate-limits', 'agent-registrations');
const claimDirectory = path.join('rate-limits', 'agent-claims');
// agent-remote-auth x-limits.consentApprovalsPerHumanPerHour: consent approvals, counted per human.
const consentApprovalLimit = { max: 10, windowMs: hourMs };
const consentDirectory = path.join('rate-limits', 'oauth-consent-approvals');
// agent-remote-auth x-limits.tokenRequestsPerSourcePerMinute: token and revocation requests, counted per source. A failure
// from §6.1 row 4 on counts once more.
const tokenRequestLimit = { max: 60, windowMs: 60_000 };
const tokenDirectory = path.join('rate-limits', 'oauth-token');

// §2 keys, from clientIp: source = IPv4 address or IPv6 /64, network = IPv4 /24 or IPv6 /48,
// wide = IPv6 /32 (null for IPv4). An IPv4-mapped IPv6 address counts as IPv4. A value that is not
// an IP address is its own source and network. Keys are keyed-hashed before they reach storage.
export function networkKeys(ip) {
  const raw = { source: `raw:${ip}`, network: `raw:${ip}`, wide: null };
  if (typeof ip !== 'string') return raw;
  const address = ip.trim().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '').toLowerCase();
  if (net.isIPv4(address)) return ipv4Keys(address.split('.').map(Number));
  if (!net.isIPv6(address)) return raw;
  const groups = expandIpv6(address);
  if (!groups) return raw;
  if (groups.slice(0, 5).every(group => group === '0000') && groups[5] === 'ffff') {
    const [high, low] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return ipv4Keys([high >> 8, high & 255, low >> 8, low & 255]);
  }
  return { source: `v6:${groups.slice(0, 4).join(':')}`, network: `v6:${groups.slice(0, 3).join(':')}`, wide: `v6:${groups.slice(0, 2).join(':')}` };
}

const ipv4Keys = octets => ({ source: `v4:${octets.join('.')}`, network: `v4:${octets.slice(0, 3).join('.')}`, wide: null });

// Eight zero-padded lower-case groups, with "::" and a trailing dotted IPv4 part expanded.
function expandIpv6(address) {
  let text = address;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const octets = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = half => (half ? half.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => group.padStart(4, '0'));
}

// Times inside the window, oldest first. A malformed stored time counts as absent.
const recent = (times, nowMs, windowMs) => (Array.isArray(times) ? times : [])
  .map(time => (typeof time === 'string' ? Date.parse(time) : NaN))
  .filter(time => Number.isFinite(time) && time > nowMs - windowMs)
  .sort((a, b) => a - b);

// Seconds until the count falls below max, at least 1; 0 while under the limit.
function retryAfter(times, nowMs, { max, windowMs }) {
  if (times.length < max) return 0;
  return Math.max(1, Math.ceil((times[times.length - max] + windowMs - nowMs) / 1000));
}

const toIso = times => times.map(time => new Date(time).toISOString());

// Durable limits in the document store (§2 "Durable"), so a restart does not reset them.
// Each method runs its own store.withTransaction. They must NOT be called inside another
// transaction: a nested transaction cannot take these lock keys, and the counters must commit
// even when the caller's transaction later fails.
//
// Document names and lock keys are HMAC-SHA256 under key (default: derived from
// ENVOI_DATA_ENCRYPTION_KEY, as src/server.js derives the code key), so the IPv4 space cannot be
// enumerated back from them. They were plain SHA-256 before; counters written under those names
// are not carried over. The flags were off everywhere, so no deployed counters existed.
export function createRegistrationLimits({ store, now = () => new Date(), key = sourceKey(Buffer.from(process.env.ENVOI_DATA_ENCRYPTION_KEY || 'sinaloa-development-only')) }) {
  const nowMs = () => now().getTime();
  const hash = value => sourceHmac(value, key);

  // §2 "Registration creation". All four counts are read and written in one transaction. When any
  // limit is already reached nothing is written, so a refused request never extends its own wait.
  async function consumeCreation(ip) {
    const keys = networkKeys(ip);
    const counters = [];
    for (const kind of ['source', 'network', 'wide']) {
      if (keys[kind] !== null) counters.push({ name: `${kind}-${hash(keys[kind])}`, limit: creationLimits[kind] });
    }
    counters.push({ name: 'global', limit: globalLimit });
    for (const counter of counters) counter.path = path.join(creationDirectory, `${counter.name}.json`);
    return store.withTransaction(counters.map(counter => `rate:agent-registration:${counter.name}`), async () => {
      const at = nowMs();
      let wait = 0;
      for (const counter of counters) {
        const document = await store.getJson(counter.path, null);
        counter.times = recent(document?.times, at, counter.limit.windowMs);
        wait = Math.max(wait, retryAfter(counter.times, at, counter.limit));
      }
      if (wait > 0) return { allowed: false, retryAfterSeconds: wait };
      for (const counter of counters) await store.putJson(counter.path, { times: toIso([...counter.times, at]) });
      return { allowed: true };
    });
  }

  // §2 "Claim failures": at most 5 per human per 15 minutes. Read-only.
  const claimPath = humanId => path.join(claimDirectory, `${hash(humanId)}.json`);
  async function claimLockRetryAfter(humanId) {
    const document = await store.getJson(claimPath(humanId), null);
    const at = nowMs();
    return retryAfter(recent(document?.failures, at, claimFailureLimit.windowMs), at, claimFailureLimit);
  }

  async function recordClaimFailure(humanId) {
    const name = hash(humanId);
    const target = path.join(claimDirectory, `${name}.json`);
    await store.withTransaction([`rate:agent-claims:${name}`], async () => {
      const at = nowMs();
      const document = await store.getJson(target, null);
      await store.putJson(target, { failures: toIso([...recent(document?.failures, at, claimFailureLimit.windowMs), at]) });
    });
  }

  // Check and count in one transaction, so concurrent attempts cannot all slip under the limit:
  // each attempt reserves a slot that counts as a failure unless released. The caller releases it
  // for every outcome other than a wrong code (a match, a replay, any other error, a 5xx).
  async function reserveClaimAttempt(humanId) {
    const target = claimPath(humanId);
    return store.withTransaction([`rate:agent-claims:${hash(humanId)}`], async () => {
      const at = nowMs();
      const failures = recent((await store.getJson(target, null))?.failures, at, claimFailureLimit.windowMs);
      const wait = retryAfter(failures, at, claimFailureLimit);
      if (wait > 0) return { retryAfterSeconds: wait };
      await store.putJson(target, { failures: toIso([...failures, at]) });
      return { reserved: new Date(at).toISOString() };
    });
  }
  async function releaseClaimAttempt(humanId, reserved) {
    const target = claimPath(humanId);
    await store.withTransaction([`rate:agent-claims:${hash(humanId)}`], async () => {
      const failures = (await store.getJson(target, null))?.failures;
      const index = Array.isArray(failures) ? failures.indexOf(reserved) : -1;
      if (index < 0) return;
      await store.putJson(target, { failures: failures.filter((_, position) => position !== index) });
    });
  }

  // agent-remote-auth §5.2 step 2: every approve request counts, checked and recorded in one transaction.
  async function consumeConsentApproval(humanId) {
    const name = hash(humanId);
    const target = path.join(consentDirectory, `${name}.json`);
    return store.withTransaction([`rate:oauth-consent:${name}`], async () => {
      const at = nowMs();
      const times = recent((await store.getJson(target, null))?.times, at, consentApprovalLimit.windowMs);
      const wait = retryAfter(times, at, consentApprovalLimit);
      if (wait > 0) return { allowed: false, retryAfterSeconds: wait };
      await store.putJson(target, { times: toIso([...times, at]) });
      return { allowed: true };
    });
  }

  // agent-remote-auth §6: checked and recorded in one transaction. A refused request is not recorded, so it never extends
  // its own wait.
  const tokenPath = ip => path.join(tokenDirectory, `${hash(networkKeys(ip).source)}.json`);
  async function consumeTokenRequest(ip) {
    const target = tokenPath(ip);
    return store.withTransaction([`rate:oauth-token:${hash(networkKeys(ip).source)}`], async () => {
      const at = nowMs();
      const times = recent((await store.getJson(target, null))?.times, at, tokenRequestLimit.windowMs);
      const wait = retryAfter(times, at, tokenRequestLimit);
      if (wait > 0) return { allowed: false, retryAfterSeconds: wait };
      await store.putJson(target, { times: toIso([...times, at]) });
      return { allowed: true };
    });
  }

  return { consumeCreation, claimLockRetryAfter, recordClaimFailure, reserveClaimAttempt, releaseClaimAttempt, consumeConsentApproval, consumeTokenRequest };
}

// §2 "Polling": a poll less than 4 s after the previous recorded one gets retry-after 5 s and is not
// recorded. In memory only; it is not a safety boundary. Past 10,000 entries, entries older than an
// hour are dropped.
export function createPollLimiter({ minIntervalMs = 4000, retryAfterSeconds = 5 } = {}) {
  const lastPoll = new Map();
  const maxEntries = 10_000;
  function check(registrationId, nowMs = Date.now()) {
    const previous = lastPoll.get(registrationId);
    if (previous !== undefined && nowMs - previous < minIntervalMs) return retryAfterSeconds;
    lastPoll.delete(registrationId);
    lastPoll.set(registrationId, nowMs);
    if (lastPoll.size > maxEntries) {
      for (const [key, time] of lastPoll) if (nowMs - time > hourMs) lastPoll.delete(key);
    }
    return 0;
  }
  return { check };
}
