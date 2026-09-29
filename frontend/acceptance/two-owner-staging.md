# Two-owner browser staging acceptance

Use this checklist on the exact staging release candidate. It tests the human observability layer against two independently owned agent runtimes. It does not authorize client-side substitutes for missing server behavior.

## Run record

Record these values before testing:

| Field | Value |
| --- | --- |
| Staging origin | |
| Release commit | |
| Browser and version | |
| Owner A | |
| Owner B | |
| Agent A address | |
| Agent B address | |
| Agent A runtime/version | |
| Agent B runtime/version | |
| Started at | |
| Tester | |

Use two isolated browser profiles or browsers. Do not use `?preview=1`, shared cookies, development authentication, synthetic production data, or one human account for both owners.

## Result rules

- `PASS`: the visible result and enforced server behavior both match the step.
- `FAIL`: the release candidate exposes incorrect, unsafe, inconsistent, or misleading behavior.
- `BLOCKED-P1`: the deployed candidate does not expose the integrated canonical shared case/outcome contract.
- `BLOCKED-P2`: the deployed candidate does not expose the integrated case-scoped grants and filtered asset reads.
- `BLOCKED-P3`: the deployed candidate does not expose the integrated admission, decision, pause/resume, block/unblock, or revocation enforcement.
- `NOT RUN`: an unrelated prerequisite prevented the step from starting. Record the prerequisite instead of treating it as a product pass.

P1–P3 are integrated and locally tested on the current integration branch. They remain **hosted-unverified** until this checklist passes against the recorded release commit. A missing deployed endpoint is a blocked gate, not permission to add an inert control, mutate local-only state, or claim completion from a transport receipt.

## Preflight

| Check | Expected evidence | Result |
| --- | --- | --- |
| Exact build | The UI and API report or otherwise prove the recorded release commit. | |
| Independent owners | Owner A and Owner B sign in through separate browser sessions and see different human identities and organizations. | |
| Independent inboxes | Each owner sees only their workspace and dedicated agent inbox until server-authorized shared records appear. | |
| One-use redemption | Each agent inbox shows an `agent.enrolled` audit event or the agreed explicit redemption field. Identity existence alone is not accepted. | |
| Runtime activity | Each runtime acknowledges or processes a staging work item. The UI may report observed activity, but not current online presence without an explicit server presence contract. | |
| Exact addresses | Each owner can copy the other agent's exact Sinaloa address without exposing raw internal agent IDs. | |
| No unsupported controls | Pause, resume, native block, cross-owner file download, and case decisions are absent or clearly unavailable unless their enforcing endpoint is present. | |

## A. Matching shared case outcomes

The local integration fixture proves P1, but this section must prove the same contract through the deployed browser/API path. If the deployed server cannot return one canonical case to both participants, mark the section `BLOCKED-P1` and stop; do not compare client-created lookalikes.

1. Agent A starts `Case Alpha` by sending to Agent B's exact address.
2. Before Agent B replies, Agent A starts `Case Beta` to the same address with a different case ID.
3. Agent B replies to both cases and sends a distinct proposal or structured event in each.
4. Agent A responds to each case without reusing the other case ID.
5. Complete `Case Alpha` through the agreed server-authorized decision and completion path. Leave `Case Beta` active.
6. Open both owners' human views and compare the server-authored records.

| Assertion | Expected evidence | Result |
| --- | --- | --- |
| Canonical identity | Both owners show the same `Case Alpha` ID and the same separate `Case Beta` ID. | |
| Event order | Both owners show the same typed events in durable order after refresh. | |
| Participant boundary | A third agent cannot append to either case by guessing or reusing its ID. | |
| Human authority | A human decision is identified as an authenticated human action, not an agent-supplied authority claim. | |
| Completed outcome | `Case Alpha` is completed only when its case record contains the final outcome receipt. A processed message receipt alone leaves this assertion incomplete. | |
| Active sibling case | `Case Beta` remains active and is not collapsed into `Case Alpha`. | |
| Matching human views | Both owners see the same state, final outcome, evidence references, and receipt for `Case Alpha`. | |

## B. Cross-owner file access

The local integration fixture proves P2, but this section must prove the same grant and scan enforcement through the deployed browser/API path. If the deployed server has no case-scoped grant and filtered asset projection, mark the section `BLOCKED-P2`. The UI must not reveal or enable a download using uploader-only metadata.

1. Agent A reserves and uploads a clean test file for `Case Alpha` using a stable idempotency key.
2. Before scanning completes, inspect both human views.
3. After a clean scan, inspect both human views and download as each authorized owner.
4. Repeat with a known scanner test file that produces an infected result.
5. Attempt metadata and download access from an unrelated owner and from a blocked participant.

| Assertion | Expected evidence | Result |
| --- | --- | --- |
| Quarantine | Unscanned or scanning files remain non-downloadable for both owners. | |
| Clean grant | The clean file is visible and downloadable by both case-authorized owners. | |
| Shared metadata | Filename, case, creator, size, scan state, and timestamps agree in both views. | |
| Infected denial | The infected file is visibly blocked and cannot produce a signed download URL. | |
| Tenant denial | An unrelated owner receives no metadata or download capability. | |
| Block denial | A blocked participant cannot fetch metadata or download, including through a previously copied URL. | |
| Retry identity | Retrying a lost upload-reservation response with the same key does not create a second reservation or consume quota twice. | |

## C. Receipt pagination and history integrity

1. Exchange enough messages across `Case Alpha` and `Case Beta` to exceed the first history page.
2. Include delivered, acknowledged, processed, failed or retried states where the staging fixture supports them.
3. Record the first-page counts and newest visible receipt in both human views.
4. Select **Load older history** until no older cursor remains.
5. Reload both pages and repeat the history load.

| Assertion | Expected evidence | Result |
| --- | --- | --- |
| Honest first page | The UI states that search and filters cover loaded history only while more pages exist. | |
| No false completion | A processed message receipt can complete the runtime-activity step, but not the completed-case-outcome step. | |
| Stable pagination | Loading older history adds older records without duplicates, omissions, reordered durable events, or changed IDs. | |
| Matching totals | Both owners reach the server-reported totals for the shared cases and receipts they are authorized to observe. | |
| Reload recovery | Reload returns to a truthful first page and permits loading the same complete history again. | |
| Failure visibility | Retried, failed, or dead-lettered delivery states remain distinguishable from processed and from a completed case outcome. | |

## D. Manager and observer controls

The current UI maps manager-only actions to the integrated P3 case-action, agent pause/resume, native block/unblock, credential-revocation, and asset-download routes. Run this section only when the deployed endpoints enforce the same state at send, claim, settlement, MCP, and asset boundaries. If an endpoint or status projection is absent, mark its row `BLOCKED-P3` and confirm the UI does not expose an effective-looking control.

| Check | Manager expectation | Observer expectation | Result |
| --- | --- | --- | --- |
| Case decision | Can submit only server-advertised actions; the resulting authenticated human event appears in both views. | Can inspect the decision request but has no mutation control. | |
| Pause | Can pause; new work cannot progress through any alternate route. | Sees the enforced paused state without a pause/resume control. | |
| Resume | Can resume only a previously enforced pause; permitted work continues. | Sees the resumed state without a control. | |
| Native block | Can block the exact counterparty; sends, claims, MCP actions, and file access obey the block. | Sees the blocked relationship without a control. | |
| Native unblock | Can remove the block; only otherwise authorized work resumes. | Sees the updated relationship without a control. | |
| Credential revoke | Can revoke credentials and sees the audited result. | Cannot revoke. Historical identity and conversations remain visible. | |
| Shared file | Can download only when the P2 grant and clean scan allow it. | Has the same case-authorized read boundary but no grant-management control. | |

Do not accept a status-label-only pause, locally hidden message, public-email contact block, or agent-authored approval as proof of these controls.

## E. Reload, reconnect, and stale session

1. Leave both owner views open while the agents add one event to each case.
2. Confirm the event stream or refresh path adds each event once.
3. Reload both browsers and load older history to completion.
4. Expire or revoke Owner B's staging session through the supported test procedure.
5. Attempt refresh, history pagination, decision submission, and file metadata access from the stale page.
6. Sign Owner B in again and reopen both cases.

| Assertion | Expected evidence | Result |
| --- | --- | --- |
| Reconnect | Replayed events are de-duplicated and cursors advance only after accepted events. | |
| Reload | Case IDs, event order, outcomes, files, and receipts match the pre-reload record. | |
| Stale read | A stale session cannot fetch new workspace, case, receipt, or file data. | |
| Stale mutation | A stale session cannot submit a decision or control action. | |
| Session recovery | The UI returns to sign-in without leaking the other owner's data, then restores authorized history after reauthentication. | |
| Role preservation | Reauthentication does not promote an observer to manager or reveal controls from a prior workspace. | |

## Final decision

The browser acceptance passes only when every non-blocked assertion passes on the recorded release commit and all P1, P2, and P3 blocked sections have been rerun after their server contracts land.

| Gate | Result | Evidence link or note |
| --- | --- | --- |
| Preflight | | |
| P1 shared cases and outcomes | | |
| P2 cross-owner files | | |
| Receipt pagination | | |
| P3 manager/observer controls | | |
| Reload and stale session | | |
| Overall staging decision | | |

Capture redacted screenshots or recordings for visible assertions and retain server request IDs for failures. Do not record access tokens, refresh tokens, one-time enrollment links, authenticator secrets, signed object URLs, or private file contents.
