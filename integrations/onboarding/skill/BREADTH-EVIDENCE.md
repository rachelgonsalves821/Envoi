# Phase B multi-route evidence worksheet — blank, not acceptance

Use only against one deployed staging release after the Phase A gate, published and approved Phase B contracts, and an owner-approved test plan. This file contains no observations. Never convert an empty cell or a provider's marketing claim into PASS. Keep credentials, bootstrap codes, cookies, message bodies and private file contents out of this worksheet and its linked redacted evidence.

| Release and operator | Value |
| --- | --- |
| Envoi exact deployed SHA | UNPROVEN |
| Staging health/readiness and timestamp | UNPROVEN |
| Approved contract IDs and versions | UNPROVEN |
| `/connect` skill/JSON byte hashes | UNPROVEN |
| Owner and second independently authenticated human | UNPROVEN |
| Rollback target | UNPROVEN |

For every named probe, record the actual connection route separately from its delivery/wake mode. `connected/on demand` is an honest possible result; it does not satisfy an automatic-wake claim. Use **BLOCKED BY PROVIDER** only with the specific observed missing interface, review outcome or restriction. Preserve an evidence link to the provider decision or redacted test. Do not paste an operational credential into a model-visible tool call to bypass a block.

| Host probe | Runtime/version and host ID | Connection route; client/connector version | Auth mechanism; owner claim; private storage | Identity and inbox response IDs | Send/reply receipt IDs | Wake mode; two closed-app arrivals | Restart and catch-up | Refresh/renew; revoke | Sensitive-write approval behavior | Result and redacted evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| OpenClaw | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Muse | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| ChatGPT Dots | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Grok consumer app custom MCP connector | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Grok automation webhook trigger | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Grok Bot event routine | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| xAI Responses API bridge | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Instinct | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |
| Generic trusted HTTPS client | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN |

## Required route and safety observations

Record PASS, FAIL, UNPROVEN or BLOCKED BY PROVIDER for each item, with timestamp, request/case ID and a redacted evidence reference. A failure belongs to the exact host, route, integration version and Envoi SHA used; rerun it after a change.

| Observation | Result | Evidence reference and actual behavior |
| --- | --- | --- |
| Fresh local-helper enrollment and Hermes ↔ OpenClaw exchange on one canonical case | UNPROVEN | UNPROVEN |
| Cloud-only remote MCP/OAuth: hosted discovery, consent/claim, authenticated identity and availability, send/reply, renewal, same-identity reconnect, revoke | UNPROVEN | UNPROVEN |
| Remote MCP paused call returns HTTP 409 `AGENT_PAUSED`, not a successful JSON-RPC envelope | UNPROVEN | UNPROVEN |
| Reviewed provider connector: approved install, private credential binding, real identity/inbox/send/reply tools and sensitive-write approval | UNPROVEN | UNPROVEN |
| Portable REST: owner needs no GitHub account or source checkout; trusted client completes claim, identity/inbox, send/reply, duplicate, restart and revoke | UNPROVEN | UNPROVEN |
| Each advertised automatic host: two distinct arrivals while app/chat closed, independent wake/claim/reply, event-channel loss and durable catch-up, restart, pause/resume/revoke | UNPROVEN | UNPROVEN |
| On-demand host: owner UI labels it On demand and makes no unattended-reachability promise | UNPROVEN | UNPROVEN |
| Same identity/address/history after reconnect through a different supported route | UNPROVEN | UNPROVEN |
| Unrelated tenant denied identity, inbox, case and file access | UNPROVEN | UNPROVEN |
| Unapproved scope expansion denied; wake notification contains no message or file content | UNPROVEN | UNPROVEN |
| Clean file available only after scan; infected/quarantined file denied | UNPROVEN | UNPROVEN |
| Duplicate notification/retry produces one canonical reply and settlement | UNPROVEN | UNPROVEN |
| Pending, rejected, expired and mismatched human claims grant no operational access | UNPROVEN | UNPROVEN |
| Model transcript, browser and logs contain no operational or installation-private secret | UNPROVEN | UNPROVEN |

## Decision

- Individually proven connection routes and delivery modes: **UNPROVEN**.
- Provider-blocked probes and exact reasons: **UNPROVEN**.
- Default `/connect` copy names only proven routes: **UNPROVEN**.
- Human acceptance and release approval: **UNPROVEN**.
- Phase B multi-route gate: **UNPROVEN**.
