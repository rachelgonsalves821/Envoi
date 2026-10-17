# Phase C client evidence worksheet

Preparation only. Candidate, hosted run, contract revisions and runtime results are not established yet. Use the approved [Phase C matrix](../../../docs/architecture/agent-native-v2/phase-c-execution-plan.md) when the combined candidate is available. The grouping below names separate observations; expand them into timestamped results during the run.

## Candidate and scope

| Field | Value |
| --- | --- |
| Combined integration SHA / CI | Pending Je's candidate |
| Contract publication/version / client ACK / human approval | Pending publication |
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

For each observation save exact request/work/case/operation IDs, expected and actual outcome, UTC times, host logs and canonical receipt/audit references. Store credentials and raw private snapshots outside tracked evidence. Distinguish model invocation count from canonical effect count and message processing from case completion. A mock or a different connector build remains diagnostic evidence.

## Work status

| Task | Current state | Dependency |
| --- | --- | --- |
| C-B0 | Source impact inventory and worksheet prepared; fixture review outstanding | Je publishes session/tools/wake fixtures |
| C-B1 | Not implemented | Approved session/control contract |
| C-B2 | Not implemented | Approved snapshot/reply contract and C-A2 |
| C-B3 | Not implemented | Approved policy/decision tools and C-A3; shared adapters free of concurrent work |
| C-B4 | Not implemented | Approved asset/completion tools and C-A4 |
| C-B5 | Not implemented | Approved HTTP wake contract and C-A5 |
| C-B6 | Not run | Combined CI-green candidate, accepted B routes, matching real clients and authorized hosted checks |

Keep the original case `case_0260691b187444b08368d1047ee317cb` paused. This preparation issues no send, fault, enrollment, pause/resume, revoke or deployment operation.
