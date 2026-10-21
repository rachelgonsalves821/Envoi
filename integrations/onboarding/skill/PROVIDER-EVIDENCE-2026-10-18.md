# Phase B named-host provider evidence — 2026-10-18

Status: preparation only. **Muse OPEN. Instinct OPEN.** Neither host has provider approval or accepted closed-app wake evidence established by this review. This is a bounded review of the sources below, not a claim that no private provider evidence exists elsewhere.

## Baseline and provenance

- Repository: `rachelgonsalves821/Envoi`; freshly fetched branch `origin/integration/agent-native`, exact base `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`.
- Task branch: `lane-b/phase-b-provider-preparation`. Date uses Rachel's America/Toronto context. No provider account was opened, connector installed, submission sent, credential created or test message transmitted.
- Authority: [Phase B completion plan](../../../docs/architecture/agent-native-v2/phase-b-completion-plan.md), B-R4/B-R5/B-R6/B-R8; [PRD](../../../docs/PRD.md), named-host requirements. One canonical registration/installation, case and work system remains authoritative.
- Build-board evidence reviewed: [issue #34](https://github.com/rachelgonsalves821/Envoi/issues/34). The [PR135 client checkpoint](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6255138891) explicitly leaves actual Muse/Instinct closed-app proof outstanding. Offline transport/receiver tests do not supply provider acceptance. No accepted real-host proof for these two hosts was identified in the reviewed material.
- [Compatibility matrix](COMPATIBILITY.md), [setup probes](HOST-SETUP-PROBES.md), and [Muse research](../../../docs/muse-wake-research-2026-09-30.md) are investigation starting points, not pass certificates.
- Historical Instinct proposal: `codex/instinct-gateway-plan` at `20dc6e8`, `docs/instinct-gateway-implementation-plan.md`, outside this integration baseline. Its account/mailbox observations and old enrollment suggestions are historical leads only; no code or authorization model is imported. [Current constrained proposal](INSTINCT-EMAIL-BRIDGE-PROPOSAL.md) requires separate review.

## Public source check

Opened on 2026-10-18; public documentation is capability context, not account-specific verification.

| Source | Observed | Evidence limit / next verification |
| --- | --- | --- |
| [Muse connector guidelines](https://platform.muse.ai/docs), permissions and submission sections | Reviewed connector intake includes tool documentation and test access. Sensitive writes require approval each time. | No Envoi submission ID, approval, account installation or wake contract was obtained. Ask the provider to classify Envoi send/reply; do not infer standing send permission. |
| [Instinct public site](https://instinct.com/) | Describes a text/call assistant using a phone and computer. | This page does not establish an Envoi connector, authenticated email bridge or unattended invocation contract. Inspect the actual account and request provider documentation. |
| [Instinct terms](https://instinct.com/terms) and [privacy policy](https://instinct.com/privacy-policy) | Pages were reachable as provider review inputs. | No legal clearance or integration approval is inferred. Provider/account-specific permission and data handling review remain outstanding. |

## Open evidence register

All unobserved fields below are **not supplied / untested**, never implicit passes.

| Required evidence | Muse | Instinct | Next evidence owner |
| --- | --- | --- | --- |
| Exact product/version, plan, region, account capability screenshot | Not supplied | Historical fixed integrations/mailbox report only; not reverified | Rachel supplies redacted account observation; Codex records scope |
| Provider route approval, review ID/date, approved tools and restrictions | Not supplied; blocked | Not supplied; supported route undecided; blocked | Je prepares technical material; Rachel submits/consents |
| Private auth, claimed installation binding, renewal/reconnect/revoke | Untested on real host | Untested; bridge authority requires contract design | Je publishes contracts; Codex verifies approved client flow |
| Real identity/inbox/send/reply with canonical receipts | Untested | Untested; email-only exchange would be bridge-mediated | Codex supplies runner; authorized owner performs real-host steps |
| Write-consent behavior and allowed unattended actions | Provider classification missing | Provider policy/account behavior missing | Provider determination plus owner-visible observations |
| Read-only/denied consent and exact-action approval | Untested; no mutation under read-only or denied/stale consent | Untested; email is not owner consent | Je defines enforcement; Codex prepares negative cases |
| Supported wake trigger, limits and restart guarantees | Not established | Mailbox-trigger hypothesis only | Provider documentation and account proof |
| Two closed-app items with exactly one authorized canonical reply each | Untested | Untested | Approved host-specific gate and owner countersign |
| Outage/restart, duplicate/replay, scope denial, pause/resume, revoke | Untested | Untested | Same frozen candidate and applicable server/client gate |

Je remains the accountable Phase B lead for both provider rows. Codex owns this setup/evidence preparation; Rachel owns provider/account consent and final scope/contract/release decisions. Delegated Phase C server implementation does not change these B-R owners or supply provider proof.

## Per-host acceptance worksheet

Copy separately for each exact host/product/version and route when a real run is authorized. Leave unresolved cells marked `not supplied` or `untested`.

| Field | Value to record |
| --- | --- |
| Host, version/build, account/plan/region, observed UI path | Not supplied |
| Route and provider review ID, approval artifact and tool classification | Not supplied |
| Accountable lead, operator and owner consent for this run | Not supplied |
| Frozen Envoi release SHA, staging origin, `/health` evidence, connector/helper hashes | Not supplied |
| Installation, agent/address, tenant/owner binding and private credential custody | Not supplied; use restricted evidence links for identifiers |
| Real identity, inbox, send and reply request/receipt IDs and timestamps | Untested |
| Auth renewal, lost-response recovery, reconnect and revoke | Untested |
| Wake mechanism, provider limits, scheduling cadence if applicable | Not supplied |
| App/chat closure time; item 1 and item 2 send/claim/reply times | Untested; independently timed items; no fresh owner prompt |
| Owner reopened app, prompted, or approved each action? | Record every intervention; distinguish awake-but-awaiting-consent from unattended reply |
| Read-only/denied write and changed recipient/content/scope | Untested; record approval binding and prove no effect for denied or stale consent |
| Canonical case/work/message IDs, effect count and both-owner observations | Untested; one authorized effect per logical reply |
| Outage/restart, missed/duplicate notice, scope/tenant denial, pause/held/resume | Untested; record lost-notice recovery mechanism and timestamps without a fresh owner prompt |
| Revoke, late reply/settlement, attachment/scan/grant denial | Untested |
| Result per requirement, evidence links, unresolved blockers and next action | OPEN until proof reviewed |
| Human countersign and date, or explicit scope-change reference | Not supplied |

Use synthetic content. Keep secrets, full mailbox addresses, raw private correspondence and provider credentials out of Git. Store restricted evidence separately and link a redacted summary. A provider delivery ID proves transport receipt only. The actual host must demonstrate the claimed processing behavior. A failed or blocked test stays visible; do not substitute a different host or a generic receiver test.

## Exit and beta scope

The current deliverable is preparation, not provider onboarding. [Setup checklist](PROVIDER-SETUP-PREPARATION.md) and [email proposal](INSTINCT-EMAIL-BRIDGE-PROPOSAL.md) are review inputs. Keep B-R4/B-R5/B-R6/B-R8 host work explicitly open pending supported provider authorization, real connection proof and the closed-app/lifecycle gate. A documented blocker can finish an investigation subtask while leaving the named-host objective open. Verified routes may enter an explicitly scoped limited beta; full multi-host onboarding remains incomplete unless every named host passes or Rachel explicitly changes scope.
