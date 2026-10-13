# Phase A hosted session preparation

Prepared on 2026-10-12 for Rachel and Je. **Preparation only: no hosted behavioral step has passed.** This track can run in parallel with the #76 contract correction and #72/#78 re-review. It does not call Phase B registration endpoints.

## Verified technical preflight

| Requirement | Evidence |
| --- | --- |
| Host | Rachel's Windows machine |
| Disposable profile | `C:\Users\Rachel\Documents\Codex\Envoi-phase-a-disposable-hermes\home`; existing directory and isolated CLI verified |
| Hermes CLI | `v0.21.6+774.g835c3dd`; the normal installation was not updated or reconfigured |
| Candidate | `9e178da96e840b169b17d6a2c6c99722cf0e8cab` on `integration/agent-native` |
| Validation checkout | `C:\Users\Rachel\Documents\Codex\Envoi-phase-a-candidate-prep`; detached candidate with #73 gate tooling only |
| Staging source/release/bundle/profile/CLI | All five #73 preflight checks PASS against that candidate |
| Hosted connector SHA-256 | `cb1aab5757d89bacaac425395b630eaeb956ff724c6fd257946d6ecd44f7873a` |
| Runner tests | 5/5 PASS outside the Windows sandbox; loopback networking was denied inside it |
| Model-provider access | PASS on 2026-10-12 Toronto time: a fresh isolated Nous request with invocation-only model `upstage/solar-mini4:free` returned a standalone `READY`, exit 0, no partial-response warning. Sanitized result only; no credential values recorded. Persistent default remains the unavailable `stealth/space-bunny-alpha`; use the explicit working model below |
| Time and attendance | CONFIRMED by Rachel for herself and Je: Monday 2026-10-12, 20:30–22:00 America/Toronto. Rachel explicitly requested no calendar invitation |

The read-only preflight does not prove provider access or any of the 23 observations. Re-run it immediately before the session; if staging has changed, agree on a new exact candidate and do not combine results across SHAs.

## Private provider preparation by Rachel

Use the existing provider account through a separate login session for this disposable profile. Rachel selected Nous and completed its private login. Do not import or copy another application's rotating credentials, read them aloud, or post account details. The installed Hermes Codex login implementation recommends a separate login rather than importing CLI credentials if that provider is selected later.

Run the prepared script from a private PowerShell terminal:

```powershell
& 'C:\Users\Rachel\Documents\Codex\Envoi-phase-a-gate\integrations\gates\prepare-disposable-hermes.ps1' -Action Setup
```

Select the intended provider in the wizard and complete its private login/consent. Do not repeat setup merely because a previous example named a different provider. Existing provider login does not guarantee quota or entitlement; do not accept billing changes merely to make this test pass.

Then run one ordinary real model turn, substituting the provider selected above:

```powershell
& 'C:\Users\Rachel\Documents\Codex\Envoi-phase-a-gate\integrations\gates\prepare-disposable-hermes.ps1' -Action ModelTurn -Provider nous -Model 'upstage/solar-mini4:free'
```

The helper uses the model/provider saved by setup unless optional `-Provider` and `-Model` overrides are supplied. The command above avoids the unavailable saved default without editing persistent configuration or credentials. The turn should produce `READY` without tool calls. Record only provider/model names, successful turn yes/no, runtime version and timestamp. Do not use `--safe-mode`, which ignores profile configuration. This script does not enroll an agent, start a Gateway, change the regular profile, or submit a gate result.

For this text-only check the helper explicitly selects `context_engine`, an installed Hermes toolset that resolves to zero model tools in the verified runtime. This avoids loading the profile's optional image/browser/audio tools and does not alter its persistent tool settings. If an earlier invocation asks to install `fal`, cancel that invocation rather than installing an unrelated feature, then rerun the corrected helper. A later Envoi tool-access check is a separate gate step; this zero-tool model turn does not prove Envoi tool availability.

The earlier operator run hit `Iteration budget reached (1/1)` and exited unsuccessfully; it is not readiness evidence. In this Hermes version `max-turns` counts API iterations, including completion/recovery work, not distinct user prompts. The corrected single-prompt probe permits at most three API iterations with a 120-second run budget. A partial response or nonzero exit remains a failure; only a completed ordinary model reply establishes readiness. The run budget is Hermes-managed, not a guarantee that an in-flight provider request is forcibly terminated at exactly 120 seconds. Do not resume the earlier session to substitute for a fresh completed probe.

The subsequent Nous request returned a nonretryable model-not-found error. Do not keep retrying the missing curated model. The live authenticated `/v1/models` catalog was read without changing credentials or running inference: HTTP 200, 423 models, no `stealth/space-bunny-alpha`; `upstage/solar-mini4:free` was listed with zero prompt/completion prices. Catalog presence alone was not readiness evidence. After Rachel authorized Codex to run the small check, a fresh request explicitly selecting Nous and Solar completed successfully with `READY`. Raw diagnostic output was captured privately in memory; only the sanitized verdict was emitted. This verifies model access, not any Envoi hosted behavior. It does not change the saved default, guarantee future availability or authorize billing changes. Recheck access at session start, and explicitly select the working model for the disposable Gateway rather than assuming the profile default works.

## Responsibilities and session agenda

| Owner | Before and during the session |
| --- | --- |
| Rachel / human operator | Complete private provider setup and real turn; confirm a 90-minute Toronto-time slot with Je; use a disposable staging owner/agent and a distinct staging sender; perform approval, pause/resume and disposable-family revocation; countersign only after all evidence passes |
| Lane B / Codex | Supply #73 runbook, loopback fault proxy, preflight and blank 23-row worksheet; preserve private connector state; collect sanitized connector/fault observations; never turn proxy counters alone into PASS |
| Je / Lane A | Confirm and hold one exact staging SHA; verify database/R2/scanner readiness; provide owner/sender access without transmitting secrets; collect request IDs, audit events and canonical receipts in `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md` |

Suggested session allocation: 15 minutes for preflight/model/identity setup, 20 minutes for message/restart/pause/resume, 30 minutes for refresh/SSE/retry faults, 15 minutes for disposable revocation, and 10 minutes for evidence reconciliation. This is an agenda, not a booked appointment or a promise the gate fits one session.

Use [PHASE-A-HOSTED-RUNBOOK.md](PHASE-A-HOSTED-RUNBOOK.md) and [PHASE-A-EVIDENCE-WORKSHEET.md](PHASE-A-EVIDENCE-WORKSHEET.md) for all 23 rows. Stop on any failed observation, integrate the responsible fix, and repeat the entire gate on the new SHA. No beta or existing-agent test is authorized. Gateway, connector and proxy must use the disposable profile, private state and an unused local port.

## Coordination request for Je

Phase A can proceed independently of the Phase B contract correction. Rachel confirmed herself and Je for Monday 2026-10-12, 20:30–22:00 America/Toronto, with no calendar invitation. The read-only five-check preflight was rerun before the session and passed against `9e178da96e840b169b17d6a2c6c99722cf0e8cab` with the same connector bundle hash. Recheck at session start and confirm the rollback reference and distinct disposable test owner/sender privately. Nous model access is verified with invocation-only `upstage/solar-mini4:free`, not the saved default. Lane B supplies the runner; Je collects authoritative server evidence. No hosted PASS, calendar event, merge or deployment is claimed by this preparation.
