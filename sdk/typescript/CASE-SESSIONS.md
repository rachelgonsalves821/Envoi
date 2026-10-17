# C-B1 CaseSession client work

Implementation branch: `lane-b/C-B1-case-sessions`. Dependency: published `case-session` v1 at `f5b7950b5162b37a1628afe9d3505bf9cf23c3db` (PR #115), based on integration `984051f`. Rachel explicitly approved that exact contract for client implementation in this Codex chat after Lane B's consuming ACK. This is not approval of the unfinished case-tools revisions, deployment, hosted flags, enrollment or live tests. Je retains integration and every server/fixture file.

## Implemented

- `EnvoiConnector.mintCaseSession(work, options)` checks authenticated server availability, refuses unavailable/unknown versions, and mints with the existing host access-token transport and the exact lease-only body. Host end requests carry the lease and session ID privately.
- `CaseSessionChannel` keeps its bearer, private identity/work/case/fence and host callbacks in ECMAScript private fields. JSON serialization and `modelContext()` expose only the approved model projection, never operational IDs or credentials. Tokens are not written to the connector store.
- The channel pins the transport to the configured origin's `/mcp`, refuses redirects, legacy/host tools and scope overrides, and never refreshes a session bearer or retries through installation access. It distinguishes HTTP authentication denial from JSON-RPC tool refusal.
- Absolute expiry, parent cancellation, matching session-end events and agent/installation terminal controls invalidate the channel and erase its local token. The channel reads a bounded response before returning it, rejecting results that arrive after cancellation.
- Scoped error parsing preserves the new lease/eligibility/end reasons and Retry-After metadata without echoing remote diagnostic text into errors.
- The opt-in `caseSessionHandler` runs inside the existing authoritative work loop. The trusted host admits and acknowledges work, renews the lease at most every 20 seconds, ends the private session before settlement, and cancels on the first renewal failure. Its model callback receives only the channel and cancellation signal, never the original message, lease, reply callback or installation bearer.
- Lost mint/end responses and transient transport errors have bounded, cancellable retries with unchanged request bodies. An expired, superseded or unauthenticated session permits at most one remint while authority remains valid; status is rechecked and the model must re-read its snapshot. Admission and acknowledgement are not repeated by reminting.
- Pause, case control, stale leases, eligibility loss and matching session-end events cancel the turn; late provider results and late settlement responses cannot become success. Owner event subscriptions include session creation/end audit events.

The new API is host-only: a runtime must hand only its `modelContext()` projection and a private channel binding to the model, not the connector or its durable credential store.

## Compatibility and remaining acceptance

Legacy handlers remain compatible with existing servers. Selecting both handlers is rejected; selecting the scoped handler fails closed before claiming if status does not advertise `caseSessions: { available: true, version: 1 }`. Scoped mode blocks legacy model token minting and privileged MCP forwarding. The new session routes are a server dependency, not implemented by this client PR.

This is an unshipped SDK implementation, **not a completed C-B1 release or hosted gate**. Exact-head CI and integration review remain required. Existing runtime adapters have not been silently switched to it. Real Hermes/OpenClaw/xAI adoption is C-B3 and requires its published/approved tool contracts; no advertised scoped-runtime readiness follows from the SDK unit tests. Runtime callbacks must take a fresh snapshot at the start of each newly minted channel and discard output when its signal aborts. No fallback to privileged legacy credentials may be introduced into a scoped turn.

## Validation recorded 2026-10-17

PowerShell, isolated checkout, canonical PR #115 fixtures and mocked fetch only:

- New `sdk/typescript/test/case-session.test.ts`: 41 passing tests; `case-session-work.test.ts`: 18 passing tests, including cancellation, bounded reminting, lost responses and lease renewal.
- `npm run test:sdk:typescript`: 258 passing tests, no skips/failures.
- `npm run typecheck` and `git diff --check`: pass.
- Frontend: 350 passing tests, including two session-event regressions. Integrations: 260 passed / one existing skip; Python SDK: six passed.
- Backend: 535 passed / 19 skips without a PostgreSQL test database. PostgreSQL/container/deployment checks still require GitHub CI; no local pass is claimed for skipped checks.
- Generated web/download artifacts are rebuilt only with `npm run build`; exact regeneration is checked before committing.

No GitHub CI, hosted gate, live provider/model effect or deployment result is claimed by this local validation record. Other preparation/review worktrees are preserved. Original case `case_0260691b187444b08368d1047ee317cb` is untouched and must remain paused.
