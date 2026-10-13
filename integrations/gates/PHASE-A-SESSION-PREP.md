# Phase A hosted session preparation

Updated 2026-10-13 for REQUEST lane-b 6149888145. **Preparation only: all hosted behaviors remain UNPROVEN.** The October 12 slot and the `9e178da` preflight are historical, not current release or model evidence. No new appointment is booked.

## Fresh preflight pin

The runner is based on integration `83dadf556c49b82c664b746702113c04c8638dd5`. This is a preparation base, **not** the final Gate GA candidate. Lane A must pair #84 with #85 on one SHA and the human must select/deploy/freeze the resulting candidate. Re-pin this table from a **fresh** preflight on that candidate, immediately before the session; do not carry forward a previous PASS, timestamp or bundle hash.

| Requirement | Current evidence / required fresh value |
| --- | --- |
| Final exact integration candidate | UNPROVEN — record the paired 40-character SHA |
| Fresh preflight UTC | UNPROVEN — record the current run, not the October 12 report |
| Staging release/readiness | UNPROVEN — matching SHA, configurationValidated: true, database/object storage/scanner ready |
| Hosted/local connector SHA-256 | UNPROVEN — copy only the successful fresh preflight hash |
| Disposable Hermes profile | UNPROVEN — operator supplies an absolute separate home with its own CLI |
| Hermes observed and expected version | UNPROVEN — exact equality required; historical reference was 0.21.6+774.g835c3dd |
| Disposable API_SERVER_PORT | UNPROVEN — explicitly set in private .env, distinct from the regular profile port and unused before starting Gateway |
| Proxy port | UNPROVEN — choose a fixed unused loopback port before enrollment; reuse it after restart |
| Runner tests | Previously 9; revised runner has 25 Node tests, all must pass on the selected runner head; also run through the integration CI wrapper |
| Real provider/model turn | UNPROVEN — an ordinary new turn in the disposable profile; old Nous/Solar success proves only that past request |
| Owner and distinct sender | UNPROVEN — disposable staging accounts, labels only |
| New slot and frozen staging Builds | UNPROVEN — human confirmation required; no calendar invitation requested |

On a clean checkout of the selected candidate with only `integrations/gates/**` runner differences, the operator runs:

```powershell
$gateSha = '<final-paired-40-character-SHA>'
$gateHome = '<absolute-disposable-home>'
$expectedVersion = '<human-confirmed-Hermes-version>'
$regularPort = <regular-profile-API-port>
node integrations/gates/phase-a-hosted-preflight.mjs --origin https://sinaloa-staging.rachelgonsalves821.workers.dev --sha $gateSha --hermes-home $gateHome --hermes-version $expectedVersion --regular-api-port $regularPort
node --test integrations/gates/phase-a-*.test.mjs integrations/gates/prepare-disposable-hermes.test.mjs
```

All five preflight checks must PASS. Save the sanitized report privately and transfer its candidate SHA, observed/expected version, bundle hash, ports and fresh UTC into the run header. It is only READY_FOR_MODEL_TURN; it proves no Phase A behavior. Repeat after a SHA, runtime version, bundle or profile/port change. Source mismatch or a failed check stops preparation.

## Isolated host and model preparation

The human selects a separate absolute `-HermesHome`. If a separate Hermes install is needed, its `-InstallDir` must be `<HermesHome>\bin`, because both helper and preflight resolve `<HermesHome>\bin\hermes.exe`; the Unix preflight resolves `<home>/bin/hermes`. Never update or repair the regular profile for this gate. Privately configure a distinct API_SERVER_PORT in the disposable `.env`; if config.yaml overrides the API port, reconcile that override to the same disposable port before running. Pass the actual regular profile port to preflight (8642 is only its default).

Use the explicit profile in every helper call, Gateway and connector process:

```powershell
.\integrations\gates\prepare-disposable-hermes.ps1 -Action Setup -HermesHome $gateHome
.\integrations\gates\prepare-disposable-hermes.ps1 -Action ModelTurn -HermesHome $gateHome -Provider <selected-provider> -Model <working-test-model>
```

The profile path is required; there is no personal default. The human owns provider login/consent/credential entry and real inference. The helper confines HERMES_HOME and restores it on exit. Its bounded text-only model probe uses context_engine with no optional tool installation and no --safe-mode; only a completed real reply with exit 0 establishes current model access. Verify the disposable Gateway's actual model/tool access separately. Record provider/model names and success only, never keys, account details, raw diagnostics or rotating credentials.

## Agenda and responsibilities

Allow **at least 120 minutes**, including two waits of up to about 14 minutes each. This is a planning budget, not an appointment or a promise of completion. Refresh is lazy at saved `agentTokenExpiresAt − 60 seconds` (900-second access TTL), with no force command. The status command exposes that access expiry as `credentialExpiresAt`. Plan pause across one boundary and arm lost-refresh before the next; do not mutate expiries or re-enroll to shorten the test.

| Owner | Required action |
| --- | --- |
| Human operator | Confirm a new slot with the distinct sender; choose disposable identities/profile/ports; run fresh preflight and real model turn; freeze staging Builds; approve, pause/resume and revoke only the test agent; countersign after all 23 rows agree |
| Lane B | Provide #73 tools/runbook/worksheet and sanitized connector/proxy observations; preserve private state; record successor equality without credential values; hold completion before revoke, then release after it |
| Lane A | Pair #84/#85 and verify one candidate; capture authoritative owner-view/audit/receipt evidence using its extractor and phase-a-TEMPLATE.md; reconcile IDs/sequences and publish formal gate result |

Suggested allocation: 15 minutes fresh preflight/model/identity; 30 minutes messages/restart/pause including first lazy refresh; 30 minutes lost refresh/SSE/retry including second lazy refresh; 20 minutes restored-SSE/held-settlement/revoke; 15 minutes reconciliation plus 10 minutes margin. Confirm a longer slot if preparation or provider responses need it.

Part 1's real-assets.test.ts:131 race is separate from hosted acceptance: a recipient transition can precede the sender's delivery projection, leaving queued vs delivered snapshots. #85 waits for both projections before the unchanged equality assertion. A local snapshot race, a passing unit test or proxy counter is never hosted PASS evidence.

Use PHASE-A-HOSTED-RUNBOOK.md, PHASE-A-EVIDENCE-WORKSHEET.md and Lane A's `docs/architecture/agent-native-v2/evidence/phase-a-TEMPLATE.md`. All rows remain UNPROVEN until the real session. On any failed observation, fix/integrate/deploy a new exact SHA and rerun **all 23**; do not combine releases. No deploy, real-host run or frozen Builds is claimed by this preparation update.
