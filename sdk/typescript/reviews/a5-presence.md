# a5-presence v1 consumer review

Lane B fixture-only review of publication a232f4664f795d523ed480bb2953263e66e52692. Plan: load all registered fixtures directly from test/contract-fixtures/a5-presence, validate producer schemas and ordered state/label semantics, exercise actual frontend response transport and connector status/doctor consumption, and cover optional/unknown connection, pause/resume grace and server-clock age boundaries. No B-3 production UI, types, connector or generated changes before human approval. Review branch uses the exact publication SHA as explicitly requested; it carries #61 as a dependency and only adds Lane B review files. Draft target remains integration/agent-native.

Run in PowerShell:

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = 'C:\absolute\publication-worktree\test\contract-fixtures'
npx vitest run --config vitest.presence-review.config.ts
```

When the variable is omitted, the shared fixture loader reads this worktree's
canonical directory. No fixtures are copied or modified. The registry contains
**16** cases (14 owner, 2 connector), not the publication note's count of 15.
The dedicated review contains **47 passing tests**. It is invoked explicitly;
it adds no B-3 production code and does not change the standard test includes.

Expected versus observed in the review:

| Case | Expected | Observed |
| --- | --- | --- |
| `owner-never-seen` | Setup status traffic does not constitute a work-loop check-in; Active · Not checked in yet | Same; `lastSeenAt` is recent, `lastWorkClaimAt` and `seenAt` are null |
| `owner-paused-seen-recently`, `owner-pause-response` | Paused · Seen recently, based on `lastSeenAt` | Same; no dependency on nonexistent `pausedAt` |
| `owner-resume-response`, `owner-resume-grace-expired` | Retain paused-time basis during one window, then return to work-loop basis | Seen recently at resume; Last checked in after grace expires |
| `owner-paused-needs-reconnect` | Paused · Needs reconnect; reconnect does not imply resume | Same |
| Revoked/rejected/pending owner cases | Revocation, rejection and approval precedence from §4–§5 | Same across all canonical cases |
| Consumer probes derived in memory: missing/unknown `connection` | Status unknown; no enrollment or approval fallback | Same; producer success-path schemas remain closed |
| Age probe with browser clock in 2099 | Server `asOf` minus timestamp, null retained and negative ages clamped | 42 seconds for seen-recently fixture; null/zero as specified |
| Both `agent-status-*` cases through production SDK and doctor | Additive diagnostic fields accepted; existing RUNNING/PAUSED lifecycle retained | Same; only status/health HTTP, no claim, delta, enrollment or runtime bridge |

`frontend/src/App.tsx` currently calls enrollment/approval "online"/"Enrolled"
and reads `pausedAt`; `frontend/src/types.ts` has neither `connection` nor
`resumedAt`/`paused`. These are B-3 implementation changes after approval, not
contract mismatches. The review-only types express optional `connection`, an
open state string, `resumedAt?` and the owner projection's `paused` boolean.
Production types are untouched.

The current doctor accepts the added status fields but does not print them.
Displaying presence is optional under §4.1/§7; a later approved consumer change
can expose the four timestamps using server `asOf`, while keeping lifecycle
decisions dependent on a3/a4 state and codes. `lastSeenAt` must be labeled
"Last request", and `lastWorkClaimAt` describes a check-in rather than work
received. Setup reports, enrollment and an open dashboard cannot establish
runtime liveness.

Owner `connection` belongs only to workspace human projections, including inbox
views and pause/resume responses. An agent-authenticated list omits it, agents
read their own family's `presence` through status, and counterparties,
participant directories and events must never carry it. This review validates
the published response fixtures and transport compatibility; A-3 must test the
actual projection/access behavior and conditional timestamp writes on both
storage backends. The deliberate separate presence-document storage described
in §1 remains subject to human contract approval.
