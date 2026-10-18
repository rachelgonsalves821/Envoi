# Phase C client evidence worksheet

Preparation only. No hosted Phase C run is established. Use the approved [Phase C matrix](../../../docs/architecture/agent-native-v2/phase-c-execution-plan.md) when the combined candidate is available. The grouping below names separate observations; expand them into timestamped results during the run. The implementation checkpoint below records published work as of 2026-10-17; it is not release approval or a completed gate.

## Candidate and scope

| Field | Value |
| --- | --- |
| Combined integration SHA / CI | Pending Je's candidate |
| Contract publication/version / client ACK / human approval | Session/tools `15fff09` reviewed and explicitly approved; wake `269d969` reviewed, separate human implementation approval outstanding |
| Hosted release SHA / readiness / freeze | Not checked |
| Connector/helper/source hashes | Not captured for a hosted candidate |
| Real host/product/version and authorized route | Not selected |
| Two owner identities and isolated fresh test profiles | Not prepared |
| Existing Phase B gate evidence for this route | Pending Je's evidence |
| Live send/fault/revoke approval references | None for Phase C |
| Rollback reference | Pending candidate |

## Client observations

| Rows | Evidence to capture | Status |
| --- | --- | --- |
| C01–C03 | Real session/installation/work/fence binding, bounded canonical snapshot and simultaneous-case isolation | Not run |
| C04–C06 | Typed reply and canonical receipt; lost response/identical replay; conflicting key and recipient override rejection | Not run |
| C07–C09 | Proposal/counterproposal and accept/reject; actual authority decision; signed-in human approval and continuation | Not run |
| C10–C12 | Clean granted artifact visible to both owners; quarantine/infected/ungranted denial; final case outcome receipt | Not run |
| C13–C15 | Restart/offline recovery; dropped wake plus supported polling; same-work retry with stale-fence rejection | Not run |
| C16–C18 | Pause mid-turn; lease/session expiry; revoke mid-turn and late-operation denial | Not run |
| C19–C21 | Verified challenge/signature/replay handling; server SSRF evidence from Je; duplicate/missed callback recovery | Not run |
| C22–C24 | Correct owner views and CSRF/sign-out; cross-tenant denial; matching artifacts and compatible rollback | Not run |

For each observation save exact request/work/case/operation IDs, expected and actual outcome, UTC times, host logs and canonical receipt/audit references. Store credentials and raw private snapshots outside tracked evidence. Distinguish model invocation count from canonical effect count and message processing from case completion. A mock or a different connector build remains diagnostic evidence. The offline inspector checks metadata and bounded local proof-file existence/containment, not proof contents or authenticity; a structurally valid index never certifies a hosted gate.

## Work status

| Task | Current state | Dependency |
| --- | --- | --- |
| C-B0 | Impact inventory, session/tools consuming149 and wake consuming307 checks passed; evidence preparation remains separate | Final implemented candidate and current contract review before hosted run |
| C-B1 | Private session/host lifecycle client published in CI-green PR118 | Integration with the implemented server and real-runtime acceptance |
| C-B2 | Typed nine-tool client published in CI-green PR120 | Integration with the implemented server and real-runtime acceptance |
| C-B3 | xAI/OpenClaw client increments in CI-green PR124/125; Hermes transport-only PR127 CI-green; runtime tool-isolation gaps remain | Verified safe real-provider admission/recovery; OpenClaw early-refusal safety correction is local, not full adoption |
| C-B4 | Owner file/outcome increment published in CI-green PR126 | Combined integration and actual two-owner asset/receipt proof |
| C-B5 | Canonical wake fixtures reviewed; receiver not implemented | Exact wake human approval and implemented C-A5 |
| C-B6 | Not run | Combined CI-green candidate, accepted B routes, matching real clients and authorized hosted checks |

Keep the original case `case_0260691b187444b08368d1047ee317cb` paused. This preparation issues no send, fault, enrollment, pause/resume, revoke or deployment operation.
