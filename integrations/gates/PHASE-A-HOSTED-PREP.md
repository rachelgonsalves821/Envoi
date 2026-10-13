# Phase A hosted test preparation and evidence sheet

**Preparation only; no hosted gate has passed.** The authoritative Phase A evidence belongs in `docs/architecture/agent-native-v2/evidence/phase-a-<sha>.md`, assembled by Lane A and countersigned by the human after the complete hosted run. This Lane B worksheet can be copied there. It follows [v3 §29](../../docs/architecture/agent-native-v2/build-plan-v3.md) and the [two-lane execution plan](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md). Every status below starts **UNPROVEN**. Local FileStore/CI results cannot substitute for a healthy hosted build with a real runtime.

## Disposable reference host

- Windows Hermes CLI was located and `hermes --version` returned `v0.21.5+8877.g865ba90` on 2026-10-11. This confirms a CLI is installed, **not** that its provider configuration or Envoi connection works.
- Empty, separate profile directory prepared at `C:\Users\Rachel\Documents\Codex\Envoi-phase-a-disposable-hermes`. It contains no copied user profile, Envoi tokens, or agent identity. Do not point a hosted test at Rachel's existing Hermes profile or production Envoi address.
- In the test PowerShell window, set `$env:HERMES_HOME = 'C:\Users\Rachel\Documents\Codex\Envoi-phase-a-disposable-hermes'` **before** starting Hermes. Confirm `hermes --version` and `hermes profile --help` in that same window. Keep this profile and its credentials out of Git; remove it after the evidence is accepted using a checked absolute path.
- Use a disposable human-owned staging agent and a separate sender, with permissions sufficient for the fixture. The human supplies provider configuration through the host's private setup path, not in chat, a command argument, or this worksheet. Do not use the old live Hermes2 identity.
- Run only after an exact integration commit is deployed to healthy staging, `/health` reports that same SHA, the shared connector bundle hash matches the release manifest, and the human has authorized the hosted fixture. Phase A uses **credential-family** revocation; installation revocation is Phase B.

This Hermes run is a reference proof of the shared lifecycle and durable-delivery path. It is **not** a brand requirement for Envoi. The same server contract must accept other runtimes; each host must separately prove its own launch, secret storage, tool access, and closed-app wake capabilities. See [the compatibility matrix](../onboarding/skill/COMPATIBILITY.md). In particular, an open-chat test for Muse or ChatGPT Dots must not be reported as unattended wake.

## Evidence header to fill at run time

| Field | Value |
| --- | --- |
| Candidate commit (40-character SHA) | UNPROVEN |
| Staging origin and `/health` release SHA | UNPROVEN |
| Exact connector bundle SHA-256 and release-manifest match | UNPROVEN |
| Hosted PostgreSQL/database evidence | UNPROVEN |
| Hermes CLI/runtime version and OS | `v0.21.5+8877.g865ba90`; recheck at run |
| Disposable profile and test-agent identifiers | Record redacted labels only |
| Human owner/sender distinctness | UNPROVEN |
| Start/end UTC and operator | UNPROVEN |
| Server audit/request IDs and redacted connector log location | UNPROVEN |
| Human countersign and build-board gate comment | UNPROVEN |

For each step, record `PASS`, `FAIL`, or `UNPROVEN`, UTC time, request/audit IDs, and a concise observed result. Never commit credentials, claim codes, message bodies, private file names, cookies, or raw HTTP transcripts. Keep raw logs in a private ignored location and publish only sanitized evidence. If a step fails, fix the owning component, redeploy the exact candidate, and rerun **all** 23 steps; do not splice passes from different SHAs.

## Required 23-step fixture

| # | Action and evidence to capture | Status | Request/audit IDs and observed result |
| --- | --- | --- | --- |
| 1 | Disposable Hermes connects to the exact staging release; identity and scoped permissions confirmed. | UNPROVEN | — |
| 2 | Hermes receives and processes native work; one canonical effect and receipt. | UNPROVEN | — |
| 3 | Stop/restart the connector process; preserve its private state. | UNPROVEN | — |
| 4 | Hermes reconnects to the same identity and continues correctly, with no duplicate output. | UNPROVEN | — |
| 5 | Human pauses Hermes; capture server state and connector state. | UNPROVEN | — |
| 6 | Other agent sends new work addressed to paused Hermes. | UNPROVEN | — |
| 7 | Work remains in the durable queue/inbox. | UNPROVEN | — |
| 8 | Held work does not dead-letter or consume a delivery attempt merely due to pause. | UNPROVEN | — |
| 9 | Authentication refresh succeeds during pause without granting claim/send rights. | UNPROVEN | — |
| 10 | Human resumes Hermes. | UNPROVEN | — |
| 11 | Held work becomes claimable immediately, preserving conversation ordering. | UNPROVEN | — |
| 12 | Hermes processes the held work once; canonical output and receipt match. | UNPROVEN | — |
| 13 | Simulate a committed successful refresh whose HTTP response is lost. | UNPROVEN | — |
| 14 | Connector retries with the same persisted `rotationId`. | UNPROVEN | — |
| 15 | Server returns the exact same successor credential family; compare privately, publish only equality. | UNPROVEN | — |
| 16 | Confirm rolling refresh expiry advances; publish timestamps, not credentials. | UNPROVEN | — |
| 17 | Drop SSE while leaving authenticated REST available. | UNPROVEN | — |
| 18 | Bounded safety polling retrieves eligible work without the SSE event. | UNPROVEN | — |
| 19 | Trigger retry-delayed work. | UNPROVEN | — |
| 20 | Connector processes it when eligible, even without a new SSE event; one effect/receipt. | UNPROVEN | — |
| 21 | Revoke the disposable **credential family** (not a Phase B installation). | UNPROVEN | — |
| 22 | Connector enters terminal `REVOKED` state. | UNPROVEN | — |
| 23 | Further refresh, claim, send, MCP write, and late settlement all fail. | UNPROVEN | — |

## Post-run decision

Record the exact SHA and one result per step. `GATE GA PASS` requires all 23 PASS, matching release and bundle hashes, server-side audit evidence, and human countersign. Otherwise mark **NO-GO** and keep the Phase B `/connect` skill unpublished. Do not infer Muse, ChatGPT Dots, or another host's wake capability from a Hermes pass; extend the same worksheet with a host-specific compatibility and closed-app wake test when those adapters are ready.
