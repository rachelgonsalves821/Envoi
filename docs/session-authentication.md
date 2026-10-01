# Session renewal and browser privacy

The application renews expired WorkOS access tokens while the provider session
remains renewable. Temporary provider failures return HTTP 503 and preserve the
session cookie so a later request can retry. Terminal failures clear the cookie
and require sign-in. Password and provider MFA requirements are unchanged.

## Server behavior

- `SINALOA_SESSION_HOURS` remains the fixed application session maximum (24 hours
  by default). Refresh does not move the maximum; WorkOS can enforce an earlier
  expiry. There is no new application inactivity timer.
- Authentication resolves once per HTTP request. The rotated sealed cookie is
  appended before response headers are sent, preserving CSRF cookies.
- Session-scoped transactions coordinate refresh and logout through the existing
  storage adapter. A fixed 30-second replay window shares encrypted replacements
  across concurrent requests and instances. Production instances must use the
  same PostgreSQL database. FileStore supports one process.
- Logout writes a durable session-ID denial before calling WorkOS. Original and
  rotated cookies cannot regain application access after logout, even if WorkOS
  is temporarily unavailable or the application restarts.
- Live streams validate human session authorization and workspace membership
  before each event and heartbeat. Explicit logout closes matching streams
  immediately. A stream also closes at its captured access/session expiry;
  ordinary HTTP reconnection can refresh the WorkOS cookie before new stream
  headers are sent. Access-token renewal is not itself a terminal logout event.
- Revocation outside Sinaloa (for example in the WorkOS dashboard) is discovered
  when the access token needs renewal. This follows the existing provider JWT
  validation model; it does not provide immediate provider-webhook revocation.

Existing sessions without a lifecycle record bootstrap their maximum from the
current verified access token's issuance time. New sign-ins record it at the
authorization callback. Session-ID denial records intentionally persist; do not
delete them while a cookie for that session can still be presented.

## Browser behavior

History navigation removes private workspace state before the browser snapshots
the page. Restoration checks authentication before loading a workspace again.
Ordinary tab switches hide and disable the mounted workspace while validating
identity and membership on return, preserving drafts and selections when access
is still valid. Unauthenticated verification forms retain their pending inputs.

Logout and terminal expiry clear private state, close the event connection, stop
workspace polling, and invalidate pending requests. A response from a previous
session cannot repopulate the screen. Other tabs receive an origin-local session
end signal and cannot reauthenticate automatically while logout is pending.
Session storage records only an `active` or `ended` marker to retain the sign-in
notice across reloads; it contains no identity or credential data.

## Validation before release

Automated tests cover token renewal and replacement-cookie propagation,
concurrent refreshes, transient failures, fixed maximum expiry, logout racing
refresh, revocation across service restart, actual SDK sealed-cookie handling,
stale frontend responses, browser lifecycle events, and local HTTP/live-stream
expiry and logout.

In an isolated staging WorkOS environment:

1. Use a short access-token lifetime and verify active work continues through
   multiple renewals. Verify the response sets a new HTTP-only cookie.
2. Open two tabs, sign out in one, and verify the other removes private content.
   Retry protected reads and writes using the old cookie: access must be denied.
3. Leave the workspace, sign out in another tab, then use Back and Forward.
   Private content must stay hidden until successful session validation.
4. Expire the provider session and the application maximum separately. Verify
   sign-in is required and open streams cannot receive private events.
5. Interrupt provider connectivity during renewal. Verify a recoverable error,
   no mutation replay, and successful recovery when connectivity returns.
6. Verify local phone-code forms survive switching tabs to retrieve a code.

Do not copy production cookies or credentials into test fixtures or logs.
