# Canonical contract and gate status

Reconciled 2026-10-23 against integration `d05498d8dc13c6f07dc151da7a41a1619ff62436`. This page only indexes decisions that are already recorded on build board #34 (every number below is a comment id on <https://github.com/rachelgonsalves821/Envoi/issues/34>). It approves nothing, changes no schema or fixture byte, and does not reopen accepted work. The contract text in [`handoffs.md`](handoffs.md) and the registry in `test/contract-fixtures/index.json` agree with this table. If they ever disagree, the board's human comment wins, and the disagreement is a defect to fix here.

## Contracts

`PUB` = `CONTRACT-PUBLISHED`, `ACK` = Lane B `CONTRACT-ACK`, `APP` = human `CONTRACT-APPROVED`, `INT` = the `INTEGRATED` post that put it in `integration/agent-native`. A blank means the board holds no such separate record, not that the step was skipped.

| Contract | Revision | PUB | ACK | APP | INT |
| --- | --- | --- | --- | --- | --- |
| `a3-pause-auth` | v1 | 6071504491 @564b9dd | Lane B review in PR #39 | 6081701354, then 6083672443 @e97853c | 6083860137 (`3f7738d`; G0 PASS 6083860480) |
| | v2 (`envoi_` prefixes) | 6102430850 @ea55458 | | 6102906989 | with N1, 6104252205 |
| | v3 | | | 6115519443 | |
| `a4-wake` | v1 | 6086919738 @67df29d | 6089970432 | 6102088321 @e9c00ac | 6102248597 @c352cec |
| | v2 | | | 6115520834 | |
| `envoi-names` | v1 | 6089439497 @2591063 | | 6102163379 | 6102248597 @c352cec |
| `a5-presence` | v1 | 6104745681 @a232f46 | 6110073452 | 6110475657 | 6111127778 @077f5ca |
| `envoi-browser-names` | v1 | 6110244373 @1b88e1d | 6111266371 | 6111446723 | 6115653297 @ef6c4f4 |
| `agent-registration` | v1 (rev 1–3) | 6130398403 @36f7943; rev 3 6134430632 @4da219e | 6134589212 | 6130642080, fresh 6134778271 | 6137405804 @a914a41 |
| | rev 4 | 6274972461 @532789b | 6275137188; integrated-tree 6276090887 | 6275502353 | 6275919244 @4ad14b6 |
| | rev 5 | 6344623683 @b9aa369 (earlier pair 6324594912 @b099fc9) | 6344061712 (earlier pair), 6345010843 | 6346370584 and 6346396365 @b9aa369 with #178 @5ff21d1; earlier pair f8a3354 + 774bf07 (6344626717) is historical | #198 then #203, 6371328798 |
| `case-session` | v1 and the `human_decision` amendment | 6238287234 @f5b7950 | 6240990960 (amendment) | 6257953606 @f5b7950; amendment 6257953866 @15fff09 | 6243505605 @c334db1 |
| `case-tools` | v1 rev 1–3 | 6238857725, 6240328954, 6240741890 @15fff09 | 6240990960 | 6257953866 @15fff09 | 6243505605 |
| `http-wake` | v1 | 6243063889 @269d969 | 6243852729 | 6257954193 @269d969 | 6243505605 |
| `provider-browser-poll` | v1 | PR #141 @8f3c756 | | direct human authorization to the implementation task on 2026-10-18; no GitHub countersign exists or is implied | |
| `a5-presence-on-demand` | v1 | 6324488564 @cf3e39d | 6324646426 | 6324921026 @cf3e39d | #198 then #203, 6371328798 |
| `agent-remote-auth` | v1 rev 1 | 6309323897 @f103660 | MISMATCH 6319543594 | | superseded |
| | rev 2 | 6320802292 @bbd361e | 6321065617 | 6321077051 | 6321122478 @bbd361e |
| | rev 3 (Policy A) | 6343901071 @af482b0 | 6343970266 | not selected; contained in rev 4 | |
| | rev 4 (Policy B) | 6343901071 @7d85748 | 6343887844 | 6344626717 relaying PR #194 approval 6344615320 @7d85748 | #198 then #203, 6371328798 |

Exact-run references recorded with these decisions: on-demand CI 39658621237; remote-auth rev 4 CI 39798192314; registration rev 5 paired CI 39806612773 (and 39799191365 for the earlier pair); the ordered candidate #198 CI 39819555760; integration push CI at `9ddfae9` 39994248902 and at `d05498d` 39996743328. Agent-written approval relays are labelled as relays on the board. No new approval is created by this page.

## Gates

Original results and countersigns are preserved. A later rerun does not replace an earlier gate.

| Gate | Exact SHA | Lane A sign-off | Human countersign |
| --- | --- | --- | --- |
| G0 | `31a2794` | 6083860480 | |
| GA3/A2 (local real service) | `14ce3c4` | 6090081940 | |
| GA (Phase A hosted, 23 steps) | `2b18170` | 6226642223 | 6226711305 |
| B-local (real Hermes and OpenClaw, local server) | `4ad14b6` | 6277624947 | 6277661690; row 17 deviation accepted 6278867078 |
| B-local rerun on the Stage A candidate | `e8a958f` | 6304532715 | 6304550858 |
| B/C closeout | | | 6330847176 (preserved, not repeated) |

Remote-auth and provider-connector flags stay OFF; Stage A's candidate, batch and receiver are unchanged. The named-host gates, flag-on acceptance, provider registration and the WorkOS Production cutover remain human-owned and unstarted.
