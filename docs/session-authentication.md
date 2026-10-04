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
- Live streams check human session leases and local workspace membership before
  each event and heartbeat. WorkOS membership is currently memoized on the human
  object retained by a connection; it is not fetched anew for every event. Fresh
  provider membership is checked on a new connection. Tightening this freshness
  policy is a separate security follow-up; the loading fix does not extend stream
  lifetimes. Explicit logout closes matching streams
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

A normal return validates the selected workspace through an authorized
`human-view` snapshot with a minimal `requester: { id, auth: { provider,
assurance } }`. The server still requires full human authentication and workspace
membership. The client compares identity and applies current permissions before
revealing the mounted workspace. Organization/workspace-picker metadata refreshes
afterward, outside the blocking check. Missing requester metadata falls back to
the existing identity/directory/view sequence for older servers. A denied snapshot
resolves identity through `/me` so phone-only sessions reach MFA step-up rather
than being treated as workspace loss. Malformed metadata fails closed.

Return validation has a 15-second read-only deadline. Timeout aborts that flow,
leaves private content hidden, and offers Retry or Sign out. Sign out is also
available while checking and invokes the normal logout flow without the ordinary
workspace-action guard. This deadline does not apply to or replay mutations. Tune
the threshold with staging measurements; it is not a promised server response time.

Live events, polling, and manual quiet refreshes share one active workspace read
and a pending follow-up. Refresh after a mutation waits for a read started after
that request. Older-history pagination stays independent; response ordering keeps
older results from restoring stale permissions or agent state while rows merge.

Manually recreated event streams resume from bounded in-memory progress scoped
to account and workspace. Native reconnects retain their EventSource instance.
The ready checkpoint can recover progress from named events without a listener;
advancing that checkpoint requests a catch-up snapshot. Logout, account changes,
and private-state removal clear progress. Tab suspension preserves only this
session's progress and mounted drafts behind the curtain.

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

Regression coverage also exercises coalesced event bursts, refresh-after-action,
cursor scope and encoding, ready checkpoints, concurrent pagination, minimal
requester responses, old-server fallback, MFA denial, validation cancellation,
late responses, and sign-out availability on the check/failure screens.

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
