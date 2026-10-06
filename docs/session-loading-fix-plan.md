# Recurring session loading: diagnosis and proposed fix

Date: October 4, 2026

Status: Implemented locally October 4, 2026 and checked as recorded below. Deployment has not been requested; staging validation remains outstanding.

Revision: Reviewed the supplied suggestions against the current code and HAR. Phase A reduces replay and request pressure; Phase C directly shortens the blocking curtain. Stream provider-membership freshness is tracked separately and does not block these changes while connection lifetimes and authorization remain unchanged.

## 1. Problem and intended outcome

Envoi repeatedly replaces the workspace with “Checking your session…” when the user returns from another window or tab. The user also reports seeing it around menu clicks, sometimes for about a minute. This interrupts work even when the user expects their session to remain valid.

The goal is to reduce unnecessary checks, repeated event replay, and overlapping requests, and shorten the work required before the workspace becomes usable again. Private content must still be protected when an account changes, a session ends, or workspace access is removed. Drafts should survive a successful same-account recheck.

This plan concerns the session-loading problem. The separate CI failure on PR #11 is outside this implementation scope.

## 2. Evidence and confidence

Evidence comes from the supplied Chrome HAR, the live frontend behavior inspected earlier, the current source, automated tests, and an isolated authorization experiment. The HAR covers October 4, 16:18–16:23 UTC, or 12:18–12:23 PM Eastern.

| Finding | Evidence | Conclusion |
| --- | --- | --- |
| Returning to the window triggers validation | The lifecycle handler treats window blur followed by focus as a suspension and return, even when the page remains visible. | Switching between Envoi and chat can trigger the curtain before the next click. |
| Validation waits on several requests | The current chain is identity → organizations → workspace directories → current workspace view. Successful chains in the HAR took approximately 8.5–10.1 seconds. | The curtain waits for more than a session-validity check. |
| Reconnection repeats old events | Five successful event streams had neither a resume query cursor nor a `Last-Event-ID` header. They repeated the same earlier events. | Creating a new event connection without a cursor restarts replay. |
| Replayed events trigger duplicate reads | Ten workspace-view requests began within roughly 2.7 seconds, corresponding to replayed events. One request took about 23 seconds, including about 20 seconds reported as blocked by Chrome. | Uncoordinated refreshes contribute to request pressure and delayed completion. The precise browser blocking mechanism is not established. |
| Backend reads are also slow | Ordinary workspace-view reads took roughly 2.5–3.3 seconds to first byte. Directory requests were also around two seconds. | Frontend coordination will not eliminate underlying server or provider latency. |
| A protected request was rejected | The final enrollment-status request returned `401`, with “Authenticated inbox participant required.” | This is an access rejection. The HAR does not establish whether it resulted from session expiry, logout, or an access change. |

The menu handler itself changes local interface state; it does not call the session-validation routine. The reported click pattern is consistent with window return triggering validation, but the exact minute-long episode was not directly measured. A 65-second event-stream entry represents connection lifetime, not a 65-second authentication request.

The frontend explicitly shows the curtain. Private API responses use `private, no-store`; changing browser caching is not the proposed solution. All 28 completed workspace-view responses in the HAR report HTTP/3 (`h3`), including the response with approximately 20 seconds of blocked time. The HTTP/1.1 six-connections-per-host explanation does not fit that request. Aborted entries omit the protocol; their omission is not evidence of HTTP/1.1.

## 3. Security finding that constrains the fix

The curtain is an intentional privacy safeguard: the workspace stays mounted to preserve drafts, but is hidden and disabled until identity and membership have been checked. Showing old private data throughout every recheck would change that protection. This plan preserves it.

The audit also found an existing event-stream concern. Provider membership is memoized on a human object, and an open stream retains that object. Repeated stream authorization can therefore reuse an earlier provider membership result.

An isolated experiment executed the actual membership-check functions with a mocked provider:

| Scenario | Access result |
| --- | --- |
| Provider membership initially active | Allowed |
| Provider membership removed; retained human object checked again | Still allowed |
| Provider membership removed; fresh human object checked | Denied |

This confirms the caching behavior, not a production exploit or a complete live-provider reproduction. Local membership and session-lease checks still run, and streams retain their existing expiry limit. Neither Phase A nor Phase C lengthens connection lifetime or changes the stream authorization policy. Track membership freshness as a separate security change; do not extend stream lifetimes as part of this performance fix. The existing session documentation needs to distinguish checks that run per event from provider membership results reused within a connection.

## 4. Proposed implementation

### Phase A — Coordinate reads and preserve event progress

1. Add a coordinator for quiet workspace-view refreshes only: stream events, the 30-second poll, and the workspace-view part of `onRefresh`. Scope it to the current session generation, account, and workspace. Permit one active quiet refresh at a time. If another trigger arrives during it, mark a pending refresh and run one follow-up after completion. Further events can request subsequent necessary work. A caller refreshing after a mutation must await a refresh requested after that mutation, not merely join an older in-flight read.
2. Reject results and errors belonging to an earlier account, workspace, or session. Keep initial loads, workspace selection, and “Load older” outside this queue. Preserve `mergeHistory` and test its interaction with concurrent refreshes, including out-of-order responses. Merging by ID does not itself establish response freshness: incoming permissions and agent state currently replace those fields. Preserve the coalesced request's `401` handling and `403` access-loss cleanup.
3. Retain received event progress in memory, separately for each workspace within the current authenticated session. Encode the cursor using `encodeURIComponent` or `URLSearchParams` when manually creating a replacement stream. The server already accepts both `?cursor=` and `Last-Event-ID`; Phase A needs no server change. Preserve native automatic reconnect behavior.
4. Centralize the frontend data-event registry in `event-replay.ts` or a small dedicated module, distinguish progress-only listeners from refresh triggers, and test the registry against the application's emitted event types. Also accept a scoped `ready` checkpoint: the current server sends `ready.cursor` only after replay and buffered delivery. Prefer the message's inherited `lastEventId` when available; validate the payload cursor if used as a fallback. Ignore stale-session/workspace checkpoints and prevent progress from regressing. If the checkpoint covers events with no refresh listener, request a coalesced catch-up snapshot so advancing progress does not leave the view stale. A control message is not a new data-event ID, and its payload must never advance beyond the server's delivered position.
5. Clear pending refreshes and cursors on logout, terminal expiry, or account change. Workspace changes must cancel or disregard work for the previous workspace. Keep existing bounded-replay recovery, including the same EventSource instance across `replay_required`, so native event progress is retained. A stale valid cursor is a query position, not an expired lookup key; do not add a speculative replay-history-expiry mechanism. Preserve existing error handling for malformed cursors or history requiring migration.

The lifecycle watcher already de-duplicates overlapping visibility, focus, and history events, with tests. The stream effect does not depend on the organization/workspace directory arrays. No lifecycle rewrite or speculative directory-triggered stream optimization is planned unless a separate concrete reproduction demonstrates a remaining issue.

The browser tracks event IDs even for named events without application listeners; that protects automatic reconnection of the same instance. The application needs its own progress checkpoint when it closes and replaces the instance. See the [HTML EventSource processing rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

This phase should eliminate refresh bursts and repeated old-event work. It does not promise to remove the curtain or solve the underlying two-to-three-second backend latency.

### Separate security follow-up — Stream provider-membership freshness

Status: the freshness window is implemented (`src/provider-membership.js`, default 60 seconds, `SINALOA_STREAM_MEMBERSHIP_RECHECK_MS`; a failed lookup closes the stream). Automated tests use a simulated provider and clock. The live-provider test in item 1 (remove a member in staging WorkOS while a stream is open) is still to be run by hand; see `docs/session-authentication.md`.

1. Add an integration test that removes provider membership while a stream is connected, and verifies that subsequent private events are denied within the documented authorization policy. Test local membership removal separately.
2. Separate ordinary per-HTTP-request membership reuse from membership freshness on a long-lived stream. A completed lookup must not remain the stream's lifetime authority.
3. Specify the provider revalidation frequency and failure behavior before implementation. Sharing a concurrent lookup may reduce duplicate calls; any completed-result cache needs an explicit freshness bound. Measure replay performance and provider request volume so the security change does not create another latency or rate-limit problem.
4. Keep durable logout denial, session-lease checks, existing stream expiry, and denial of unauthorized events. Provider outages must not become permission to continue sending private events using indefinitely stale membership.

The frequency decision and live-provider test are outstanding. Track this work separately from the loading fix. Longer-lived connections remain excluded until the security follow-up has passed. No ticket has been created or external action taken.

### Phase C — Shorten the return-to-work authorization path

The preferred design is to extend the existing authorized `human-view` response with a hand-built requester object containing exactly `{ id, auth: { provider, assurance } }`. Do not spread the WorkOS human object, provider role/permissions, or full `/api/auth/me` result. This lets one server request establish identity, current workspace access, permissions, and the workspace snapshot together. Reuse existing authentication and projection helpers rather than duplicating their security logic.

The frontend would:

1. Keep the mounted workspace hidden and disabled while requesting that authorized snapshot.
2. Verify the response belongs to the current lifecycle generation and selected workspace.
3. Compare the server-identified requester with the previously displayed account. Clear previous-account state and drafts before handling an account change. Retain the existing insufficient-assurance restrictions. Keep the existing full Human object for same-account rendering; the minimal requester object is not a replacement for display-name and MFA-setup data.
4. Apply the fresh snapshot and current permissions, then reveal the same-account workspace.
5. Refresh organization and workspace-picker metadata afterward. A directory refresh must still remove inaccessible entries and handle a subsequently detected access change.

This removes directory enumeration from the blocking path. The requester metadata is necessary: a workspace snapshot alone is not proof that it belongs to the previously displayed account. Never return sealed cookies, tokens, or provider secrets.

Compatibility and denied-response handling are required:

- If the response has no requester field, discard it as a basis for validation and run the existing identity/directory/view sequence while the workspace remains hidden. This supports an older server, mixed deployment, or rollback. A malformed present requester fails validation; it must never reveal the old workspace.
- A denied snapshot must not be mistaken for workspace removal when the user actually needs MFA. Local `getHuman` requires MFA by default, whereas `/api/auth/me` allows a phone-only session to identify itself for step-up. The general inbox GET guard normally returns `401` before the `human-view` route's `403`, so test both statuses rather than assuming phone-only always produces `403`.
- Do not implement this fallback by catching the current `loadView` failure unchanged: `403` already invokes access-loss cleanup, and the shared API request helper synchronously broadcasts expiry on `401`, invalidating the session generation before the caller handles it. The validation-specific snapshot read needs narrowly controlled error handling. A minimal `api.ts` change may be necessary; do not globally suppress expiry notifications.
- On a current-generation denied snapshot, retain the privacy curtain and resolve identity through `/api/auth/me` and the existing account-loading/step-up flow. If identity is absent, end the session. If identity requires step-up, show the existing MFA screen without loading private workspace data. If identity changes, clear old-account state first. Genuine workspace denial must still clear inaccessible content; fallback must never override a denial with cached data or keep retrying indefinitely.
- A remote logout, pending sign-out, or new suspension must cancel this fallback. Temporary provider failures remain recoverable failures, not permission to reveal private state.

This contract change needs backend and frontend review and tests. Until it is ready, retain the existing identity and membership sequence. It cannot make provider and database state globally atomic; every later protected request must continue to authorize independently.

### Phase D — Measure remaining delay and bound failures

Measure the frontend validation interval and request counts in staging. Backend profiling is an optional separate diagnostic change if existing logs cannot explain the remaining delay: measure request duration, identity resolution, provider membership lookup, and database/projection time. Use request IDs and sanitized diagnostic fields; do not record cookies, tokens, HAR response secrets, or workspace content. New server instrumentation is not a prerequisite for the frontend replay fix.

Investigate the captured final `401` and slow responses against backend logs from the capture window. No additional browser export is required for the current frontend findings; backend evidence is needed to explain those remaining causes.

Own the timeout in the `revalidateAccount` flow or a dedicated validation helper, not in the shared API `request()` function. Cancel the validation's read-only requests through a dedicated AbortController and reject late results, rather than only racing a timer against a promise. The existing request helper already composes a caller signal with the session signal; the `humanView` API wrapper may need an optional signal parameter to expose this capability. Set the timeout threshold from measurements. A timeout must never reveal an unvalidated workspace or automatically retry user mutations.

Expose sign-out on both the checking and failure screens. Its handler must bypass `checkRenderedSession`, which deliberately blocks ordinary workspace actions while a check is pending. Invoke the existing logout flow so it clears state synchronously, cancels validation, and retains its protection against automatic reauthentication while the server logout is unresolved. Keep ordinary action guards in place. `FailureScreen` currently provides Retry only, so this is a concrete UI change to test.

## 5. Required safeguards

| Risk | Required behavior |
| --- | --- |
| Another tab logs out | Clear private state, stop streams and polling, invalidate pending requests, and reject late results. |
| Account changes | Discard the previous account's drafts, cursors, and workspace data before displaying the new account. |
| Workspace switches during a request | A response for the old workspace must not update the current one. |
| Membership or role is removed | Deny protected reads and writes server-side; remove inaccessible data or management controls when the fresh authorized response is applied. |
| Back/Forward restores a page | Preserve private-state removal before history capture and authorization before restoration. |
| Token renews | Preserve HTTP-only cookie rotation, fixed application expiry, and existing logout-versus-refresh coordination. |
| Provider is unavailable | Show a recoverable failure without granting access based on stale authorization or treating every temporary failure as terminal logout. |
| Events arrive during refresh or reconnect | Catch up without missing updates, duplicating refresh bursts, or advancing beyond received events. |
| A user action is in flight | Do not automatically resend it. Preserve existing CSRF and idempotency handling; a cancelled client request does not prove the action failed server-side. |

There is no proposal to lengthen sessions, place credentials in browser storage, cache authorization indefinitely, or remove server access checks.

## 6. Validation and acceptance

### Existing baseline

- All 104 existing frontend tests passed.
- All 60 targeted backend tests passed, covering session renewal and expiry, logout races, revocation, CSRF, authorization, event replay, and history.
- The isolated membership-cache experiment reproduced the behavior described above.

These results validate the current baseline, not an unimplemented fix. This was a focused audit of the affected paths, not a security audit of the entire application.

### New automated coverage

- A burst of ten refresh triggers produces one active request and one catch-up request when no later events arrive.
- Events arriving during the catch-up request still schedule subsequent necessary work.
- Old-session and old-workspace results, errors, and scheduled callbacks cannot affect the current session.
- Cursors remain isolated across workspaces and accounts; native and manual reconnects resume correctly; recovery notices preserve catch-up behavior. Test encoded cursors, unhandled event types followed by `ready`, stale checkpoints, and connection loss before `ready`.
- History pagination and live refreshes retain the newest authoritative permissions and current workspace state.
- Logout during validation or token refresh clears data and cannot be undone by a late response.
- Hidden-tab return and history restoration do not expose unvalidated private content; a successful same-account return preserves drafts.
- The combined snapshot contract cannot leak credentials, accept agent identity as human identity, or bypass assurance and membership requirements.
- Missing requester metadata falls back safely on an older server. Phone-only/MFA-required sessions follow step-up for both relevant denial statuses. A real workspace denial clears content; a terminal session failure signs out; no fallback can undo remote logout.
- Local membership removal, role demotion, and provider outages preserve the loading fix's existing authorization safeguards. Live provider-membership freshness on a retained stream belongs to the separate security follow-up.
- Timeout cancels validation and rejects late responses without replaying mutations. Sign-out remains usable during checking and failure and cannot expose the old workspace while logout is pending.

### Real-browser and staging checks

Use Chrome with a staging WorkOS account. Exercise repeated window switches, hidden-tab returns, continuous menu navigation, two-tab logout, account changes, workspace changes, Back/Forward, short access-token renewal, fixed maximum expiry, and interrupted connectivity. Test local-provider MFA step-up separately. Verify current membership enforcement on new requests; retain the connected-stream provider-removal scenario in the separate security follow-up.

Record loader duration and request counts before and after. Opening or closing the menu while remaining in the active page must not trigger validation. Repeated reconnects must resume progress rather than replaying the same older events. Ordinary return validation must avoid directory enumeration once Phase C is enabled.

Set a numerical loader-duration target after baseline profiling; do not promise instant return while current backend latency is unexplained. Release only after the security scenarios pass and the browser reproduction demonstrates a measured improvement.

## 7. Delivery and rollback

Deliver Phase A as a frontend-only PR and Phase C as a separate server/frontend PR. Keep stream authorization hardening in its own security change. Keep the snapshot response extension backward compatible, deploy the server before its frontend consumer, and retain old-server fallback for mixed deployments and rollback. Run existing suites and new targeted tests after each affected change.

Validate in staging before production. Roll back frontend performance changes if refreshes are missed, drafts disappear, or return latency regresses. Preserve authorization hardening during a performance rollback. Application edits were authorized; production deployment has not been requested.

## 8. Review decisions and remaining uncertainty

- Review the staged approach: request coordination and event progress first, then the authorized snapshot contract for shorter return checks.
- Track provider-membership freshness separately; neither loading-fix PR changes connection lifetime.
- Use backend evidence to determine the cause of the observed `401` and slow responses.
- Set timeout and performance thresholds from staging measurements.
- Preserve the current privacy policy. Eliminating all visible return checks would be a separate product/privacy decision.

Expected files after approval:

- Phase A: `frontend/src/App.tsx`, `frontend/src/event-replay.ts` or a small dedicated module, and targeted tests. Keep `session-lifecycle.ts` unchanged unless a concrete failing scenario requires it.
- Phase C and bounded validation: the `human-view` response in `src/server.js`, `frontend/src/types.ts`, `frontend/src/App.tsx`, targeted tests, and minimal `frontend/src/api.ts` wrapper/error-policy plumbing if required for the narrowly handled denied snapshot and AbortSignal. Do not change default mutation timeout or expiry behavior.
- Documentation: this plan and `docs/session-authentication.md`. Correct the distinction between per-event lease/local membership checks and provider membership cached on a connection.
- Separate security follow-up: stream provider-membership freshness and its integration tests. Do not include authentication-provider rewrites or new instrumentation in the loading-fix PRs.

Leave `src/auth.js` and `src/workos-auth.js` unchanged for the loading fix.

## 9. Disposition of the supplied suggestions

| Suggestion | Review outcome |
| --- | --- |
| Diagnose focus/blur, serial validation, missing cursor, refresh bursts, and membership memoization | Confirmed in the source; timing and protocol observations checked against the HAR. |
| Add denied-snapshot/MFA fallback | Accepted with corrections: phone-only can encounter the upstream `401`, and current global expiry/access-loss handlers must not run before the validation-specific fallback decision. |
| Support missing requester on an older server | Accepted; retain the privacy curtain throughout the existing sequence. |
| Construct only `{ id, auth: { provider, assurance } }` | Accepted; no spread of provider identity/role/permissions. |
| Centralize event types and use `ready.cursor` | Accepted with scoped, nonregressing checkpoints and a catch-up snapshot for events without refresh listeners. The previous blanket prohibition on ready checkpoints was too strict. |
| Remove speculative duplicate-validation/directory-recreation work | Accepted; existing lifecycle tests cover de-duplication, and directory arrays are not stream-effect dependencies. |
| Remove hypothetical replay-history expiry | Accepted; stale valid cursors resume by position. Retain existing bounded replay and actual error behavior. |
| Keep pagination out of the quiet refresh coordinator | Accepted; retain concurrency/ordering tests because mergeHistory alone does not prevent stale authorization fields winning. |
| Put timeout in validation; provide unguarded sign-out there | Accepted; add actual abort/late-result handling and preserve default mutation behavior. |
| Separate stream authorization hardening and instrumentation | Accepted; record the security issue without making it a dependency of the loading fix. |
| No `api.ts` changes expected | True for Phase A; Phase C may need minimal caller-managed denial and cancellation plumbing. |
| HTTP/1.1 six-connection limit explains the blocked request | Not supported: the relevant completed requests used HTTP/3. The exact cause remains unresolved. |
| Separate Phase A and Phase C PRs and clarify their outcomes | Accepted; Phase C is the primary change for reducing curtain duration. |

## 10. Local implementation and validation

Implemented Phase A, Phase C, and the bounded read-only validation/sign-out behavior. The normal return path uses the authorized requester-bound snapshot and starts directory enumeration afterward. Quiet reads share a coordinator with trailing refreshes. Event progress resumes manual connections; pagination remains independent with response-order guards. Old-server fallback, denied-snapshot MFA recovery, logout cancellation, and account changes preserve private-state clearing. Ordinary polling and pagination also verify requester identity when the new server metadata is present.

The return-check deadline is initially 15 seconds, above the captured legacy 8–10-second successful sequence. Timeout aborts that read flow and leaves private content hidden, with Retry and Sign out available. This prevents an indefinite curtain; it does not eliminate the deliberate check on window return or promise a specific production response time.

Local validation:

- `npm run test:frontend`: 144 tests passed, including 40 additional regression cases.
- Targeted authentication, session lifecycle, replay, history, and HTTP-security checks: 61 tests passed.
- Full backend suite: 234 tests discovered; 221 passed and 10 were skipped in the sandbox run. Three connector credential-permission tests failed because the sandbox prevented Windows ACL setup. Those same three tests passed when rerun outside the sandbox with approval. No connector source or distributed connector bundle changed.
- `npm run build`: type checks, production frontend, and connector builds passed. The tracked `web/index.html` was regenerated.
- Isolated local browser smoke check: disposable phone/MFA sign-in, workspace creation, Inbox/Activity navigation, and reload into the final build succeeded; no browser warnings/errors were recorded. The browser blocked the separate health-tab navigation, so this smoke check does not establish real tab-return timing or draft preservation across a verified suspension. Automated lifecycle/validation coverage passed; the staging browser scenarios still need execution.
- `git diff --check`: passed.

No deployment, external ticket, pull request, or provider configuration change was made. Stream provider-membership freshness remains the separately documented security follow-up. Production backend latency and the original HAR's final `401` remain unresolved without the relevant server evidence. Record staging measurements before release, particularly WorkOS renewal, mixed-server fallback, two-tab logout, account changes, and real tab-return duration.
