# Stopped Phase C progress

These trusted operator APIs grant no source, runtime, provider, send or time authority. An actual human decision and the exact reviewed execution packet remain required. They perform no onboarding and do not replay accepted tasks.

## Admission after partial Hermes processing

`ContinuationController.prepareStoppedProgress(options)` verifies evidence without modifying the ledgers or consuming a time decision. It returns an opaque process-local handle. `startStoppedProgress(handle)` rechecks that evidence, consumes any separately approved new time decision once, appends only the new window/graph records, and returns a controller. Neither method starts a host or submits a model prompt.

The bounded path covers stopped Hermes progress before new OpenClaw processing. It rejects prior new OpenClaw dispatches rather than interpreting their evidence as Hermes admissions.

Required evidence includes:

- The original execution receipt, sealed packet, source/library/graph approval, and program digest with its original window.
- A stopped-owner receipt and the exact complete canonical ledger prefix. Every prior started work, binding, phase and attempt must be reconciled. A binding with no provider invocation still counts as native history.
- For completed work, the unchanged completed journal, actual native terminal receipt, raw end/settlement evidence and recorded canonical processed result.
- For interrupted work, the unchanged unfinished journal, genuine terminal non-success receipt and actual canonical failed record. Unknown, live or successful native outcomes cannot be substituted for a failure.
- The existing action ledger and anchor, fresh normalized read-only inventory, actual cumulative model counts, zero leases/sessions and preserved original records. Counters are not reset to the historical seed values.
- The exact newly reviewed graph/source subject and applicable fixed-time or new one-use time decision. An expired fixed deadline cannot be extended by preparation, recovery or a retry.

Previously started or bound flows cannot be released again. Their canonical work hashes cannot be reused under an alias. Completed flows and controls remain separate historical proofs with their original source/window; they are never marked newly completed by this API.

## Unused allocations

A separately approved graph may mark an existing flow `retired: true` only if it has never had a binding, phase or attempt. Its original role, work hash, quota, policy and case remain in history. Retirement is irreversible and is checked on ledger replay and every admission path.

Only these unused allocations stop contributing to future allocation totals. All historical physical-request charges remain in the same hash-chained ledger. Retirement neither refunds a call or message reservation nor waives an acceptance row. Existing quotas cannot decrease in a stopped-progress transition; earlier valid historical quota amendments remain readable.

## Interrupted admission cleanup

`cancelRetainedHermesAdmission(host, {workId, journalRawBytes, journalSha256}, signal)` requires separate explicit operator authority for that one pinned unfinished work. It operates on an already selected host. It creates no host/session, submits no prompt, invokes no tool/model, and never writes a journal.

The helper validates the original profile, work, session, admission and optional returned input identity before cancellation. It may use only descriptor/resume/receipt/cancel/interrupt/detach RPCs, with a ten-second active-operation bound, the existing five-second cancellation bound, and at most one additional second for detach. It returns an actual already-completed outcome honestly; an unknown outcome is refused. Native cleanup alone is not canonical work settlement or a Phase C pass.

Any subsequent canonical failure reconciliation must use the actual SDK lifecycle with an exact eligible queue/work check and no model handler. A distinct prospective review task requires its own reviewed payload, work allocation and personal send confirmation. Never clear or replace the old journal to obtain another prompt.
