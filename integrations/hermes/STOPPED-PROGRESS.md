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

## Exact staging server adoption

Controlled recovery normally requires the historical server source unchanged. An already accepted checkpoint may adopt one separately reviewed, tested staging server through `ControlledProgressRecovery.serverAdoption`. Complete checkpoint-history and canonical-work validation still runs first. An unaccepted follow-up cannot use this exception.

The pinned `ControlledServerAdoption` descriptor names the prior server, exact replacement server and current client source, with `environment: staging`. Its pinned `ControlledServerVerification` names those same server sources, an exact successful CI head for the replacement, successful compatibility/restoration results, and one to eight hash-pinned evidence files. The verifier reads those bounded files; the release owner must independently establish their actual test provenance and human authority. A file declaring success grants neither release nor execution permission.

The target packet contains the same `serverAdoption` pin. The actual human recovery decision must additionally bind `serverAdoptionSha256` along with the existing target packet, client, server, runner, history, scope and cumulative bounds. The descriptor does not contain the target packet hash, avoiding a circular digest. Unknown descriptor/report fields, missing or changed evidence, wrong sources, or an unbound approval are refused. An unchanged server must omit the extra descriptor and approval field.

Preparation remains read-only; startup revalidates the evidence before consuming the existing one-use decision. Old receipts retain their original server sources and bytes. New receipts name the adopted server. This exception changes no onboarding, accepted send, failed original, journal, scope, budget, completed control or time policy. The operator must separately verify that the actual hosted release, image, Worker and settings match the reviewed replacement; this client receipt does not perform deployment or authorize drift.

### Checkpoint session retention

Current ended session rows remain the usual proof. For a fully inspected persistent-workflow bootstrap stop, its existing pinned canonical owner read may instead prove the checkpoint's ended sessions after cleanup. Current identity and retryability, attempt count, failure, message state and lack of live lease/session authority must still match. Each archived session must have a valid identity, fence, observed end and original expiry; the current read must be at least 24 hours after every original expiry. The descriptor's verified canonical pin is selected by history inspection, never supplied as an unverified current-row substitute. Missing, changed, early or uncertain evidence is refused. Current rows remain empty and the original task, journal, attempts, expiry, budgets and time policy are not changed. The hosted server adoption review must confirm this same documented retention rule for the exact selected server.

## Unused allocations

A separately approved graph may mark an existing flow `retired: true` only if it has never had a binding, phase or attempt. Its original role, work hash, quota, policy and case remain in history. Retirement is irreversible and is checked on ledger replay and every admission path.

Only these unused allocations stop contributing to future allocation totals. All historical physical-request charges remain in the same hash-chained ledger. Retirement neither refunds a call or message reservation nor waives an acceptance row. Existing quotas cannot decrease in a stopped-progress transition; earlier valid historical quota amendments remain readable.

## Interrupted admission cleanup

`cancelRetainedHermesAdmission(host, {workId, journalRawBytes, journalSha256}, signal)` requires separate explicit operator authority for that one pinned unfinished work. It operates on an already selected host. It creates no host/session, submits no prompt, invokes no tool/model, and never writes a journal.

The helper validates the original profile, work, session, admission and optional returned input identity before cancellation. It uses descriptor/resume/receipt/cancel/interrupt/detach RPCs, with a ten-second active-operation bound, the existing five-second cancellation bound, and at most one additional second for detach. It returns an actual already-completed outcome honestly; an unknown outcome is refused by default. Native cleanup alone is not canonical work settlement or a Phase C pass.

Restarting a native owner can change a previously started admission to `unknown`. Discarding that uncertainty requires a separate explicit human decision. Only then may the caller supply `discardUnknown`, pinning the decision digest and exact session, admission, input, native profile and observed execution generation. The helper invokes the existing `prompt.resolve_unknown` operation once and re-reads the actual terminal receipt. This never retries or requeues the original input. A genuine captured completed result is reported honestly and cannot be used as failed-work evidence. Missing authority, mismatched identity/generation, or still-unknown results stop cleanup.

The cleanup host must suppress native draining and background adapters before exposing control IPC. Both normal startup and unknown resolution can schedule successor work; denying provider forwarding alone does not prevent native tools from executing. This helper starts no host and cannot establish that bootstrap property. The reviewed cleanup wrapper must enforce owned-child teardown even on partial startup failure and verify exit within its approved fixed bound.

Any subsequent canonical failure reconciliation must use the actual SDK lifecycle with an exact eligible queue/work check and no model handler. A distinct prospective review task requires its own reviewed payload, work allocation and personal send confirmation. Never clear or replace the old journal to obtain another prompt.

### Maintenance without normal gateway startup

`cleanup-native.py` is a separately reviewed one-shot maintenance entry for an existing ACP admission. It is not an interactive native host and does not claim native model readiness. It uses the pinned native `ProfileOwnership`, `SessionDB` and `SessionAuthority`; only pending publication and scheduling are suppressed. Actual native generation-fenced uncertainty resolution and transcript closure remain unchanged. No listener, normal startup, prompt submission, model, tool, hook, cron, viewer-close recovery or background delivery adapter is started. Network connections and subprocess creation are denied inside the maintenance operation.

The owner passes exact JSON bytes on stdin to the selected native Python:

```
python cleanup-native.py --native-root <reviewed-native-root> <sha256-of-stdin>
```

The request binds `purpose: retained-hermes-native-cleanup-v1`, separate `cleanupApproved` and `discardUnknownApproved` decisions, `operatorDecisionSha256`, an absolute `deadlineMs` at most 75 seconds away, the existing `home`/`cwd`, original `workId`/journal bytes/hash and observed `executionGeneration`. `HERMES_HOME` must select that same home. `nativeFileSha256` pins the reviewed native files; the sealed operator packet must additionally pin this entry and the complete selected native tree. The caller validates actual human authority; booleans or a digest alone do not establish approval.

Before ordinary native epoch recovery, the entry rejects any other started input, transferred steer or active native worker. It also requires the exact local ACP policy/principal/workspace and no unresolved lineage adoption. It never restores captured delivery state or viewer-close timers. Its fresh authority has no in-memory captured results or owed delivery; both are checked before resolution. A queued target is preserved and refused. Queued successors remain queued, including after native resolution attempts to schedule them.

The existing database first opens read-only. Integrity, exact native schema version, declared columns and existing WAL mode must pass before a writable connection is enabled. Normal writer startup, schema initialization, automatic reopen and FTS repair are unavailable; a SQL authorizer refuses DDL, attachments and writing PRAGMAs. Damaged or old databases are refused without quarantine, replacement or migration. Original text must be bounded and match the stored native input. Deadline checks run before promotion, epoch recovery and resolution, and inside every native transaction callback/retry.

The result contains the actual native before/after receipts and a **maintenance JSON-RPC projection** of the native receipt. Those bytes are produced by this reviewed entry from the actual native authority; they are not claimed to be a prior interactive WebSocket response. Validators must distinguish that provenance. A completed terminal outcome is returned honestly and cannot be reconciled as failed. The journal is input only and is never written.

The request allows at most 75 seconds of active maintenance. The process watchdog exits after 90 seconds, including blocked input or native shutdown; already-issued tracked writes are awaited before database closure. The external owner must register the child immediately after spawn, kill only that owned child on the fixed deadline, and verify physical exit before admitting continuation. A timeout or missing receipt remains uncertain and cannot be promoted to success. This maintenance interval provides no Phase C model/run time authority.

Run `cleanup-native.test.py` with the reviewed native Python and `ENVOI_HERMES_NATIVE_ROOT` to exercise real native authority/store behavior on temporary synthetic databases, including the actual maintenance child and queued-successor preservation. It never uses a real profile or provider.
