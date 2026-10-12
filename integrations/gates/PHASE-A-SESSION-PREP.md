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
| Model-provider access | UNPROVEN: profile provider is `auto`, no profile OAuth auth store exists; a Codex login file exists, but that alone proves neither usable access nor a model turn |
| Time and attendance | UNCONFIRMED; use America/Toronto and obtain both participants' agreement before scheduling |

The read-only preflight does not prove provider access or any of the 23 observations. Re-run it immediately before the session; if staging has changed, agree on a new exact candidate and do not combine results across SHAs.

## Private provider preparation by Rachel

Use the existing provider account through a separate login session for this disposable profile. OpenAI Codex is a candidate supported by this Hermes installation, not a verified provider selection. Do not import or copy the Codex CLI's rotating credentials, read them aloud, or post account details. The installed Hermes login implementation itself recommends a separate login rather than importing CLI credentials.

Run the prepared script from a private PowerShell terminal:

```powershell
& 'C:\Users\Rachel\Documents\Codex\Envoi-phase-a-gate\integrations\gates\prepare-disposable-hermes.ps1' -Action Setup
```

Select the intended provider in the wizard, complete its private login/consent, and decline any offer to import Codex CLI credentials. If using another provider, complete its supported private setup without sending a key to an agent. Existing provider login does not guarantee quota or entitlement; do not accept billing changes merely to make this test pass.

Then run one ordinary real model turn, substituting the provider selected above:

```powershell
& 'C:\Users\Rachel\Documents\Codex\Envoi-phase-a-gate\integrations\gates\prepare-disposable-hermes.ps1' -Action ModelTurn -Provider openai-codex
```

The turn should produce `READY` without tool calls. Record only provider name, successful turn yes/no, runtime version and timestamp. Do not use `--safe-mode`, which ignores profile configuration. This script does not enroll an agent, start a Gateway, change the regular profile, or submit a gate result.

## Responsibilities and session agenda

| Owner | Before and during the session |
| --- | --- |
| Rachel / human operator | Complete private provider setup and real turn; confirm a 90-minute Toronto-time slot with Je; use a disposable staging owner/agent and a distinct staging sender; perform approval, pause/resume and disposable-family revocation; countersign only after all evidence passes |
| Lane B / Codex | Supply #73 runbook, loopback fault proxy, preflight and blank 23-row worksheet; preserve private connector state; collect sanitized connector/fault observations; never turn proxy counters alone into PASS |
| Je / Lane A | Confirm and hold one exact staging SHA; verify database/R2/scanner readiness; provide owner/sender access without transmitting secrets; collect request IDs, audit events and canonical receipts in `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md` |

Suggested session allocation: 15 minutes for preflight/model/identity setup, 20 minutes for message/restart/pause/resume, 30 minutes for refresh/SSE/retry faults, 15 minutes for disposable revocation, and 10 minutes for evidence reconciliation. This is an agenda, not a booked appointment or a promise the gate fits one session.

Use [PHASE-A-HOSTED-RUNBOOK.md](PHASE-A-HOSTED-RUNBOOK.md) and [PHASE-A-EVIDENCE-WORKSHEET.md](PHASE-A-EVIDENCE-WORKSHEET.md) for all 23 rows. Stop on any failed observation, integrate the responsible fix, and repeat the entire gate on the new SHA. No beta or existing-agent test is authorized. Gateway, connector and proxy must use the disposable profile, private state and an unused local port.

## Coordination request for Je

Phase A can proceed independently of the Phase B contract correction. Please confirm a 90-minute Toronto-time window, the exact staging candidate and rollback reference, the distinct test sender/owner, and availability to collect server evidence. The current preflight candidate is `9e178da96e840b169b17d6a2c6c99722cf0e8cab`; it must be rechecked at session start. Provider setup and the model turn are still unproven. No hosted PASS, appointment, merge or deployment is claimed by this preparation.
