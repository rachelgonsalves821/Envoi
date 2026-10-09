# a4-wake v1 consumer review

Published contract: PR #44 @ `67df29d1249bea46646180d224549d409d859450`. Review base: integration/agent-native @ `0b6e6a8fa45f33fc4f64db72a6206930c576c8c8`. This is fixture-only acceptance scaffolding; no B-2 SSE, polling, timer or cursor production changes are implemented.

The consumer suite reads the canonical registry and fixtures from the publishing worktree through `ENVOI_CONTRACT_FIXTURES_ROOT`, without copying or editing Lane A files. It consumes all 26 fixtures, checks frame and delta ordering, stable code policy through `x-codes`, own-send versus inbound wakes, closed producer privacy, pause/hint separation, and three real SDK delta-page consumptions. PowerShell result: **33 passed**. Producer schema validity does not resolve the prose inconsistency below.

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = '<publishing-worktree>/test/contract-fixtures'
npx vitest run --config vitest.a4-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

## MISMATCH: stream-from-latest cursor persistence

`handoffs.md` a4 §2 says: “Frames without an `id` never move the cursor.” The `ready` row also describes its cursor as the last sent cursor, otherwise the resume cursor, otherwise null. The earlier `from=latest` row specifically reports the newest cursor. The fixture's client instruction then requires saving that cursor despite the no-ID invariant.

Exact published fixture request (placeholder credential):

```http
GET /api/inboxes/inbox_example/events?from=latest
accept: text/event-stream
authorization: Bearer sinaloa_agent_access_PLACEHOLDER_active
```

Exact response frame, with no SSE id:

```text
event: ready
data: {"inboxId":"inbox_example","at":"2026-10-09T12:00:00.000Z","cursor":"00000000000000000044"}
```

Fixture `client.next`: “Store the ready cursor for this inbox and claim once; the queue, not history, holds pending work.”

Expected: one unambiguous rule for initializing/resetting the inbox cursor from `from=latest`, distinct from advancing a processed event cursor. Observed: the general no-ID rule forbids the update that this fixture explicitly requires. A consumer following that invariant retains null (or a rejected old cursor), while this fixture expects the newest baseline.

Request to Lane A: explicitly document the `from=latest` baseline exception and the corresponding fresh-connection / EVENT_CURSOR_INVALID reset behavior, while keeping ordinary control frames from advancing the processed cursor. Align the `ready` cursor row and fixture wording. No server patch is proposed; A-2 behavior is still future work. L3 ACK remains pending the clarification; the suite accepts the producer's explicit `from=latest` shape but cannot settle the contradictory persistence rules.

## B-2 consumption checklist after human approval

- Store cursor scope with inboxId; use Last-Event-ID precedence and drop duplicate/regressing stored events.
- Replace the periodic 5-second delta poll with SSE wake plus single-flight claims, at most one follow-up, and the defined safety timers.
- Recover replay_required through delta from the last processed cursor; handle invalid cursors through the clarified from=latest baseline.
- Read status after reconnect/ready and every 30–60 seconds while paused; neither wakes nor credential refresh silently resume claims.
- Use nextAvailableInMs, not a wall-clock comparison, for hints; retain 30–60-second healthy and 15-second ±20% disconnected claims.
- Honor 1–30-second full-jitter reconnect backoff, the 60-second reset/idle bounds, and Retry-After floors.
- Keep terminal credential fences and durable claim/settlement deduplication. Accept unknown consumer event fields and future wake reasons even though the producer schema is closed.

The listed cursor format, migration-failure envelope and polling/backoff decisions remain for human contract approval. GA3's paired Envoi identity integration is independent of this contract review.
