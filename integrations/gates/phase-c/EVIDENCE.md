# Phase C client evidence worksheet

**Prior B/C testing: human-attested complete and countersigned.** On 2026-10-21 (America/New_York), pjsk02 explicitly confirmed that the testing had passed, had been reviewed for remaining work, and could be closed. They instructed Codex to record the signature if missing. [Attributed countersign on the canonical board](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176).

This corrects the stale preparation-only status below. It records the human's acceptance, without representing a new independently observed run. The human did not supply an additional exact B/C tested SHA, host versions, artifact hashes or row-level observations in this instruction. Preserve the existing exact-run records; attach matching historical references when located. Missing transcription is a reconciliation task, not a reason to ask for a blanket repeat of completed tests.

The new P0 client composition combines #174 and #184 after that historical work. Its build and offline Windows checks are separate from the accepted historical runs. The countersign does not assert that these later client bytes were installed or deployed. See [remaining P0 work](../P0-COMPLETION.md).

## Candidate and scope

| Field | Value |
| --- | --- |
| Combined integration SHA / CI | Shared Phase C source integrated through #143; current source base `bbd361ea52aab80fc53c402130a35718f6bee561`. This is not an inferred historical hosted SHA. |
| Contract publication/version / client ACK / human approval | Session/tools amendment `15fff09` and wake `269d969` approved; board approvals 6257953866 and 6257954193. |
| Hosted release SHA / readiness / freeze | Historical B/C mapping to be attached; no new value supplied by the countersign. |
| Connector/helper/source hashes | Preserve original run hashes; do not substitute the new P0 build. |
| Real host/product/version and authorized route | Prior Hermes/OpenClaw B/C work accepted by the human; exact historical versions remain a record-linking task. No other named host pass inferred. |
| Two owner identities and isolated fresh test profiles | Covered by human closeout; identifiers remain private and are not reconstructed here. |
| Existing Phase B gate evidence for this route | Local 21/21 at `e8a958f`, merged #165/#168; broader B/C closeout is the attributed attestation above. |
| Live send/fault/revoke approval references | Preserve prior run authorizations; this document starts no new live operations. |
| Rollback reference | Historical test acceptance and the next release's operational rollback are tracked separately. |

## Client observations

| Rows | Evidence to capture | Status |
| --- | --- | --- |
| C01–C03 | Real session/installation/work/fence binding, bounded canonical snapshot and simultaneous-case isolation | Human-attested complete; historical row citations to attach |
| C04–C06 | Typed reply and canonical receipt; lost response/identical replay; conflicting key and recipient override rejection | Human-attested complete; historical row citations to attach |
| C07–C09 | Proposal/counterproposal and accept/reject; actual authority decision; signed-in human approval and continuation | Human-attested complete; historical row citations to attach |
| C10–C12 | Clean granted artifact visible to both owners; quarantine/infected/ungranted denial; final case outcome receipt | Human-attested complete; historical row citations to attach |
| C13–C15 | Restart/offline recovery; dropped wake plus supported polling; same-work retry with stale-fence rejection | Human-attested complete; historical row citations to attach |
| C16–C18 | Pause mid-turn; lease/session expiry; revoke mid-turn and late-operation denial | Human-attested complete; historical row citations to attach |
| C19–C21 | Verified challenge/signature/replay handling; server SSRF evidence from Je; duplicate/missed callback recovery | Human-attested complete; historical row citations to attach |
| C22–C24 | Correct owner views and CSRF/sign-out; cross-tenant denial; matching artifacts and compatible rollback | Human-attested complete; historical row citations to attach |

For each observation save exact request/work/case/operation IDs, expected and actual outcome, UTC times, host logs and canonical receipt/audit references. Store credentials and raw private snapshots outside tracked evidence. Distinguish model invocation count from canonical effect count and message processing from case completion. A mock or a different connector build remains diagnostic evidence. The offline inspector checks metadata and bounded local proof-file existence/containment, not proof contents or authenticity; a structurally valid index never certifies a hosted gate.

## Work status

| Task | Current state | Dependency |
| --- | --- | --- |
| C-B0 | Contracts reviewed; implementation inventory superseded by merged #143 | Keep source inclusion distinct from historical acceptance records |
| C-B1 | Private session/host lifecycle integrated through #143 | Do not reapply #118's source stack |
| C-B2 | Typed nine-tool client integrated through #143 | Do not reapply #120's source stack |
| C-B3 | Selected Hermes/OpenClaw/xAI source integrated through #143, including #139/#142 | No additional provider acceptance inferred from source inclusion |
| C-B4 | Owner files/outcomes/events integrated through #143 | Prior B/C acceptance is human-attested above |
| C-B5 | Receiver/host/driver and packaged APIs integrated through #143; normal-entry/Windows follow-ons assembled in P0 client candidate | Validate later client deltas without reopening the historical gate |
| C-B6 | Prior B/C test work human-attested complete/countersigned | Attach historical exact-release references; new release operations remain separate |

Keep the original case `case_0260691b187444b08368d1047ee317cb` paused. This preparation issues no send, fault, enrollment, pause/resume, revoke or deployment operation.
