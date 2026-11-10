# Phase C continuation without workflow expiry

`ContinuationController.prepareControlledWorkflow` and `startControlledWorkflow`
accept a separate version 2 receipt with `lifetime: 'until-complete-or-cancel'`
and `humanReview: 'before-claim'`. The receipt has no `hardStopUtc`. It is tied
to the exact reviewed source, CI head, runner, packet, human adoption and existing
cumulative ledger. Legacy version 1 receipts remain immutable fixed intervals;
the legacy entry point cannot open a version 2 workflow.

Preparation verifies the stopped history and current canonical state without
changing the ledger. Starting consumes the same durable prior-history and human
decision markers used by controlled recovery. The existing per-flow allocations,
physical request charges, operation reservations, completed observations,
accepted sends, failed original and incomplete native journal are carried forward.
No account, enrollment, send, journal reset or historical success is inferred.

## Personal selection before the queue claim

1. `reserveOwnedOpenClawWork` prepares the exact restricted native configuration
   in a separate private directory. It reserves the chosen loopback gateway port
   with an inert socket that rejects connections. It starts no native core,
   canonical claim, case session or model request. The existing physical proxy
   must remain closed to forwarding until actual native/work admission.
2. The trusted operator displays the static subject from
   `openClawPreclaimDigest`: source, native and factory policy, model, workflow,
   work/case/recipient/installation/inbox, process, paths, config and exact
   gateway/proxy. A genuine personal answer produces the new purpose
   `phase-c-personal-preclaim-native-selection`, lifetime
   `one-claim-until-cancel`. There is no human-response timer. A legacy target,
   capability, time or source approval is not this answer.
3. `approveOpenClawPreclaim` verifies that answer and creates an in-memory branded
   approval. The receiver's `beforeClaimReview` hook must return these approvals
   before it enables its explicit queue driver. While this hook waits there is no
   lease or native deadline to expire. Cancellation interrupts the wait.
4. Recheck current identity/enrollment, authenticated status and authoritative
   work facts after the answer. The receiver re-reads saved enrollment/config;
   the SDK checks authenticated status immediately before claiming. Any changed
   reviewed subject needs a new review. Stale privileged inventory is not fresh
   merely because the workflow has no expiry.
5. After the real queue claim and server-created case session,
   `bindReservedOpenClawWork` binds the exact session, fence, tool-channel and a
   finite native deadline no later than the real session expiry. The receiver
   verifies that expiry independently. The method durably consumes one private
   reservation marker; it cannot bind another session or overwrite an old marker.
6. Use the returned `selection` through `readOpenClawPreclaimSelection` and the
   returned `capability` through `startOwnedOpenClawWork`. The new capability is
   a deterministic allocation binding from the branded consent and fresh scope,
   not another human answer or an actual runtime observation. The full existing
   target digest still covers the session, fence, token/path hashes, tool-channel
   and native deadline.
7. Start releases only its own inert gateway socket immediately before the
   exact child binds. A port race fails startup; it never changes the reviewed
   port. The owned child's source/config/core/registry/transport observations,
   strict IPC and physical request gate remain mandatory. Reserve/close/cancel
   cleans up only its owned resources and cannot permit an unreviewed retry.

The current canonical claim API selects queue work unconditionally. This client
does not invent an `expectedWorkId` contract or claim atomic conditional matching.
An unexpected returned claim is recorded with its real lease and attempt, then
the controller stops before model submission. It is never processed, silently
refunded or released through an unsupported private route.

## Bounds and completion

Only workflow and human-response expiry are removed. Individual network
operations, the original native 120-second admission bound, actual case-session
leases, cancellation and every spending/fixture limit remain enforced. A failed
assertion pauses work with its evidence; it does not create a success or an
unlimited retry. A new source still requires exact reviewed adoption.

The operator must close the workflow and owned resources when all applicable
Phase C rows finish or the human cancels. Passing these offline tests is not a
hosted Phase C pass. Actual processing/reply evidence, the remaining applicable
matrix, final preservation/cleanup and the human results countersign are still
required.
