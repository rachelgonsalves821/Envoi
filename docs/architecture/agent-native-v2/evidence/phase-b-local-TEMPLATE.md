# Gate B-local evidence: TEMPLATE

Copy this file to `phase-b-local-<40-character-sha>.md` for the run. It covers v3 §47 rows 1–17, plus the two-owner plan's Phase B gate items (rows 18–20), on **one** exact integration SHA, using real Hermes and OpenClaw against a **local** server. The procedure is [`../gate-b-local-runbook.md`](../gate-b-local-runbook.md).

A pass here is a local-server result. It is not the hosted Phase B gate, the §47 breadth gate, or closed-app reachability evidence.

**Never record** tokens, bootstrap tokens, `activationId`s, verification codes, cookies, message text, model-provider account details or raw HTTP. Server tables come only from `scripts/ga-evidence.mjs`.

## Run header

| Field | Value |
| --- | --- |
| Gate SHA (`integration/agent-native`, clean tree, `npm run build` with no drift) | |
| `/health` `releaseSha` and mode (before and after) | |
| `GET /api/onboarding/routes`: offered routes and modes (expect exactly `local_helper`, `envoi_link`) | |
| `/connect/skill.json` offered lists equal the routes endpoint; `/connect/SKILL.md` byte-identical to the repository | |
| Flags on: `ENVOI_INSTALLATIONS_V2`, `ENVOI_AGENT_REGISTRATION_V2`; `ENVOI_AUTHENTICATED_REST_ROUTE` unset | |
| Server: `npm start` (FileStore or local PostgreSQL), fresh `ENVOI_DATA_DIR`, HTTPS front end on `https://localhost:8443` | |
| Private helper: `integrations/onboarding/dist/envoi-link.mjs` SHA-256 | |
| Hermes version, OS, model provider (name only); fresh profile with no Envoi config | |
| OpenClaw version, OS, model provider (name only); fresh profile with no Envoi config | |
| Owner (local development human); approver hint shown (expected `d***@development.invalid`) | |
| Hermes agent id and address; OpenClaw agent id and address; agent inbox ids | |
| UTC start and end; operator | |

## Rows

`S` = server evidence (cite event `sequence` and ids from the sanitized tables). `H` = host, helper or connector observation (Lane B or the operator). A row is `PASS` only when every listed source agrees.

| # | Observation | Server evidence (S) | Host evidence (H) | Status |
| --- | --- | --- | --- | --- |
| 1 | Hermes starts with no Envoi config | no agent or registration for it yet | empty state directory | |
| 2 | Human asks Hermes to connect itself | — | the request in the human-visible chat | |
| 3 | Hermes reads `/connect` | — | it fetched `/connect` and `/connect/SKILL.md` and saw `local_helper` offered | |
| 4 | Hermes invokes `envoi-link connect` | — | the exact command, against `https://localhost:8443`, `--runtime hermes` | |
| 5 | Helper registers privately | `claims`: no entry yet; the registration is pending (operator poll shows `pending_claim`) | bootstrap saved in private state only | |
| 6 | Model sees only the claim URL and code | — | redacted transcript: only `claimUrl`, `verificationCode`, `expiresInSeconds` and safe state | |
| 7 | Human approves | `agent.registration_approved` (`registrationId`, `target: new_agent`); `claims` row `approved` | owner typed the code at `/claim` (never in a URL) | |
| 8 | Helper collects credentials privately | `agent.installation_activated` (`installationId`, `connectionRoute: local_helper`, `deliveryMode: envoi_link`); `claims` row `activated` with the same `installationId` | host-native confirmation by the human (approver hint, workspace, agent, permissions) before activation; credentials only in private storage | |
| 9 | Connection starts | `installations`: one active, `legacy: false`; agent view `connection.state` | authenticated status before "connected"; connector in the foreground | |
| 10 | Hermes receives native work | `message.delivered` → `agent.work_claimed` → `message.processed` for one message from the owner's test sender; one processed receipt | one model turn acted once | |
| 1–10′ | OpenClaw: rows 1–10 repeated | the same events for the OpenClaw agent | the same, with `--runtime openclaw` | |
| 11 | Hermes sends OpenClaw a message | `message.queued` from Hermes; `message.delivered` to OpenClaw | the human approved this send | |
| 12 | OpenClaw replies | `agent.work_claimed` and `message.processed` on OpenClaw; its reply `message.delivered` to Hermes | one reply | |
| 13 | Restart OpenClaw | presence `lastSeenAt` stops, then resumes | process stopped and started with the same state directory; no re-registration | |
| 14 | Send new work (while it is down) | `message.delivered` with OpenClaw offline | the human approved this send | |
| 15 | OpenClaw recovers it | the next `agent.work_claimed` carries the **same** `credentialFamilyId` as row 12; one `message.processed`; one receipt | processed exactly once | |
| 16 | Revoke its installation | `agent.installation_revoked` (`installationId`); `installations`: `ended`, `endedReason: revoked`; agent **not** frozen (agent view `status` not `revoked` by agent-wide freeze) | — | |
| 17 | Further processing stops | no `agent.work_claimed`, `message.processed` or receipt for OpenClaw after the revoke time | connector `REVOKED`; no re-enrollment; refresh, claim and send denied with `CREDENTIAL_REVOKED` | |
| 18 | Same identity reconnects | a new registration approved as `existing_agent` (`replacesInstallationId: null`); a new `agent.installation_activated` for the **same** `agentId`; address unchanged | the human ran a new `envoi-link connect` and confirmed | |
| 19 | History kept | earlier cases and messages are still listed for the same agent | the reconnected runtime receives work at the same address | |
| 20 | Backend and UI agree | `installations` table: the revoked one ended and the new one active | the owner UI installation view shows the same states | |

## Result

| Field | Value |
| --- | --- |
| Rows PASS | / 21 (row 1–10′ covers OpenClaw's rows 1–10 together) |
| Defects found (lane, PR) | |
| Lane A sign-off (`GATE B-local PASS/FAIL @sha`) | |
| Human countersign | |
