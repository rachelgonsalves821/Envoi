# Muse connector installation boundary

Status: Envoi-side **owner intent only**, 2026-10-06. This code does not connect Muse, issue a durable Muse credential, or wake Muse. It is disabled by default through `SINALOA_MUSE_CONNECTOR_INSTALL_ENABLED`; even when explicitly set to `1`, it creates only a pending, non-authorizing installation record. Never label it connected in the UI.

## What the code does now

An enrolled, active Muse identity already has a dedicated Envoi inbox and a five-minute read probe. Its linked human may request a future connector installation through `POST /api/inboxes/{agentInboxId}/agents/{agentId}/muse-connector-installations` with exactly `{ "mode": "read" }` or `{ "mode": "work" }`. A human-authenticated session, CSRF protection, active workspace management membership, and an exact match to the Muse identity's principal human are required. The response contains `id`, `agentId`, `inboxId`, `ownerHumanId`, `mode`, `status: "awaiting_provider_contract"`, `credentialIssued: false`, and `createdAt`; it contains **no token, refresh secret, authorization code, or linking URL**. `GET /.../{installationId}` reads that record. `POST /.../{installationId}/revoke` marks this pending intent revoked. These calls neither revoke nor elevate the existing agent credentials.

The route is a safe place to record owner intent while the provider contract is unresolved. It is not a substitute for account linking. Existing one-use enrollment, 15-minute v1 access credentials, rotating one-use refresh credentials, family revocation, inbox authorization, work leases, and idempotent settlement remain unchanged for non-Muse connectors. The current Muse identity remains probe-only, with no claim or send rights.

## Missing confidential handoff

Meta's [Connector Platform guidelines](https://muse.ai/platform/docs) ask for authentication setup such as OAuth client credentials or an API key, plus API or MCP tool docs. They do **not** publish the reviewed connector's exact OAuth profile, secure refresh storage guarantee, tool transport, or third-party event ingress. The tested personal Muse connector hit proxy/Sentinel denials before either authenticated GET reached Envoi. An owner browser response containing a 30-day refresh credential would expose the secret to browser JavaScript and could be copied into a generic API-key field or prompt, so this branch deliberately does **not** issue one.

Before enabling a real link, obtain from Meta the reviewed connector's confidential callback/token exchange or secure credential-capture contract; allowed callback origins and registered redirect URIs; client authentication and PKCE requirements; access and refresh-token handling; consent and revocation behavior; and whether its client calls REST or Streamable HTTP MCP. Then implement a server-side code exchange and a one-installation, one-agent credential family. Short access tokens, rotating refresh, family revocation, and owner/agent scoping can reuse Envoi's existing primitives, but they need a provider-approved handoff that keeps refresh secrets out of browser pages, prompts, logs, URLs, and general-purpose API-key fields. If Meta only supports a static API key without secure rotation, keep the bounded read probe; do not paste a full work credential into Muse.

## Typed action contract for Meta review

The existing Envoi routes are canonical backend building blocks, **not yet approved Muse tools**. A reviewed REST connector can map them after Meta approves the transport. If Meta accepts remote MCP, a curated facade can map the equivalent existing `/mcp` tools. Do not assume that `POST /mcp` registration alone overcomes the observed Sentinel policy or starts a Muse task.

| Intended Muse tool | Existing Envoi action | Proposed Meta classification and requirement |
| --- | --- | --- |
| `envoi_identity` | `GET /api/agent/me` | Read. Address comes from the credential; no caller-selected agent. |
| `envoi_check_work` | `GET /api/agent/work/availability` | Read. Counts only; no message text. |
| `envoi_claim_work` | `POST /api/agent/work/claim` | Write. Lease one item from the credential's inbox. |
| `envoi_renew_work` | `POST /api/agent/work/{workId}/renew` | Write. Requires a fenced lease. |
| `envoi_acknowledge_work` | `POST /api/agent/work/{workId}/acknowledge` | Write. Fenced and idempotent. |
| `envoi_complete_work` | `POST /api/agent/work/{workId}/complete` | Write. One canonical processed receipt after a confirmed outcome. |
| `envoi_fail_work` | `POST /api/agent/work/{workId}/fail` | Write. Explicit retryable or permanent failure. |
| `envoi_reply_in_case` | Canonical `POST /api/inboxes/{agentInboxId}/messages` | Propose **sensitive write** with exact recipient, case, text and idempotency key. Current Muse installation has no grant for this. Meta's decision on per-use approval is required. |

Owner intent for `read` means only identity and availability in a future installation; `work` means read, claim and settlement. Neither mode implies send. Untrusted peer text must not be treated as instruction to bypass approvals. A notification or claim is not a processed receipt. A failed or uncertain send must use the same idempotency key and report status honestly.

## Next implementation and acceptance gates

1. Meta confirms an exact confidential auth and tool transport. Add the server-side exchange against that contract; test owner consent, one-agent/one-inbox binding, short access, refresh rotation/replay, revoke, tenancy, and no secret leakage. Keep it disabled until review succeeds.
2. A real Muse tool call returns authenticated `200` for identity and work availability with matching Envoi logs and exact release SHA. This is currently unproven because Muse blocked the request before Envoi.
3. Meta classifies claim, settlement, and reply. Test approved sends to a same-staging Hermes identity; denial sends nothing, and retries yield one canonical message. Do not imply unattended sensitive writes.
4. Separately prove a Meta-supported app-closed schedule or documented event mechanism. No Meta webhook or wake endpoint is implemented here.

Local verification: `node --test test/muse-connector-installation.test.js test/muse-probe.test.js test/work-claims.test.js test/agent-mcp.test.js test/auth-enrollment.test.js`. The new installation tests verify the feature gate, owner/tenant checks, exact request shape, no credentials in the response, pending status and revocation, and no effect on probe credentials. They do **not** prove provider authentication or a live Muse call.
