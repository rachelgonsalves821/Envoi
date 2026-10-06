// Remembers a person's WorkOS organization membership on their `human` object so
// one request, or one open event stream, does not call WorkOS again and again.
//
// A normal HTTP request is short, so it keeps the first answer for as long as the
// request lasts (no age limit). An event stream stays open for minutes, so it must
// pass `maxAgeMs`: once the remembered answer is older than that, the next check
// asks WorkOS again. Without it, someone removed from the organization could keep
// receiving live events until the stream closed.
//
// If WorkOS cannot be reached, the lookup rejects and the caller must deny access.

export const DEFAULT_STREAM_RECHECK_MS = 60_000;
const MINIMUM_STREAM_RECHECK_MS = 1_000;

// Reads SINALOA_STREAM_MEMBERSHIP_RECHECK_MS. Anything that is not a number of at
// least one second falls back to the default, so a typo cannot disable rechecking.
export function streamRecheckMs(value, fallback = DEFAULT_STREAM_RECHECK_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MINIMUM_STREAM_RECHECK_MS ? Math.floor(parsed) : fallback;
}

const remembered = Symbol('provider-membership');

export function createProviderMembershipCache({ lookup, now = Date.now }) {
  return function providerMembership(human, organizationId, { maxAgeMs = Infinity } = {}) {
    if (!human[remembered]) Object.defineProperty(human, remembered, { value: new Map(), enumerable: false });
    const entry = human[remembered].get(organizationId);
    if (entry && now() - entry.at < maxAgeMs) return entry.answer;
    // Store the pending lookup straight away so overlapping checks share one call.
    const answer = lookup(human.providerUserId, organizationId);
    human[remembered].set(organizationId, { at: now(), answer });
    return answer;
  };
}
