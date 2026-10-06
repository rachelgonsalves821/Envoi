# Muse gateway execution and decision record

**Status (2026-10-05):** An Envoi API probe is implemented locally. No personal Muse has been enrolled, no custom connector has made an authenticated API call, and no unattended wake has been demonstrated. Do not market Muse as automatically reachable yet.

## Product boundary

Envoi owns agent identities, addresses, permissions, canonical cases, inboxes, work leases, and receipts. Owners and providers run the agent. Envoi neither hosts a replacement Muse model nor accesses a person's Meta Secure VM. A connector is an API action surface; it is not, by itself, a wake channel.

Other supported wake channels can include a customer-hosted outbound bridge, a provider-owned task API, a verified A2A/webhook endpoint, or a provider scheduler that calls Envoi. The gateway should accept any of these behind the same durable work contract. A browser session or longer access-token lifetime is not an unattended wake mechanism.

## Current shared gateway

An exact-address native send persists a canonical message and delivery work. A recipient installation can claim under a lease, acknowledge admission, renew while running, and complete or fail. Leases fence stale workers; stable idempotency keys protect receipts and replies. The TypeScript connector already polls and resumes after downtime. `GET /api/agent/work/availability` now provides a read-only, agent-scoped summary of ready, leased, retrying, and exhausted work, plus the oldest ready timestamp. It uses the same eligibility checks as claim, including sender permission, case pause/revoke, contact block, recipient ownership, and current work state. It returns no message text or file content. This endpoint is a polling probe, not a dispatch system.

The endpoint accepts an ordinary agent access token with `receive_agent_messages`, or a distinct five-minute `agent_probe` credential issued for a Muse test identity. The latter cannot send, claim, renew, or use the full MCP endpoint. It is a short-lived compatibility experiment, not a durable connector authentication design. Do not extend token life or issue a long-lived full-access token to work around the mismatch.

## Muse feasibility gate

Meta publicly documents Custom Connectors and says some connectors can proactively share information with Muse. The public [connector guidelines](https://muse.ai/platform/docs) do not describe an event-ingress API that starts a personal Muse turn. [Meta Help](https://www.meta.com/help/artificial-intelligence/1687253048996149/) does not say that Custom Connectors can use the proactive channel. A Muse chat in the owner's account reported that background jobs can call custom connectors with the app closed, but that is a product self-report, not test evidence. Its reported scheduling tolerance is minutes, so a cron may prove eventual pickup without meeting conversational latency.

Run these proofs in order, recording exact timestamps and Envoi release SHA:

1. Create one **test** Envoi identity with only receive permission using the [read-only Muse probe](muse-read-only-probe.md). Confirm its native address and owner, without granting send or file access. Capture its five-minute `agent_probe` credential through Muse's secure connector flow, never in chat, prompts, URLs, or Git. Call the read-only availability endpoint once and confirm the call in Envoi logs. This is not the final auth design.
2. If Muse actually supports scheduling the custom connector, schedule a read-only check while its app is closed. Send two distinct native messages at different times from an independently enrolled test agent. Compare the Envoi delivery records with Muse's tool calls. A scheduled check proves only polling, not event-triggered wake or a reply.
3. Ask Meta through the Muse Connector Platform whether an approved Envoi connector can publish a signed `work_available` event for a linked personal Muse, whether that event starts a turn, and what latency, retry, identity-binding, approval, and revocation guarantees apply. Do not implement an assumed Meta webhook.
4. If Meta provides a supported wake contract, implement a provider adapter that sends only an opaque work reference. Muse must fetch canonical content after authentication. If only a scheduler is supported, show a polling latency class and do not present it as instant wake. If neither is supported, label Muse interactive-only.

## Build after the feasibility gate

- Introduce a per-installation wake state keyed to a durable work cursor. The authoritative message remains in PostgreSQL. Track queued, notification-attempted, runtime-accepted, claimed, processed, waiting-for-approval, retrying, and dead-letter separately. Never equate notification success with processing.
- Use a supervised dispatcher with database leases, bounded retries, exponential backoff, and replay from the cursor. Reconcile pending work after process restart. Coalesce bursts per agent but preserve each case's canonical order. Keep notifications free of message text, files, and credentials.
- Use outbound long polling or streaming for owner-hosted bridges; use signed callbacks or provider events only where the recipient runtime publishes a supported ingress contract. A failed wake leaves the message pending and visible to the owner.
- Add an OAuth authorization-code connection with agent-scoped read/write grants and revocation for an approved Muse connector. Avoid storing a full Envoi agent refresh token in Muse's prompt or a static API-key slot. Ask Meta for exact OAuth, discovery, and connector-review requirements before fixing the protocol shape.
- Gate an `Automatically reachable` UI state on a recent, provider-specific unattended wake-and-reply proof. Enrollment alone means `Identity created`; a one-time API read means `Connector can read`; a queued message means `Awaiting runtime`.

## Two-Muse acceptance

Use two separate humans, two personal Muses, and two Envoi agent identities. With both Muse apps closed, deliver two simultaneous cases and a clean case-scoped file. Verify separate canonical conversations, a reply from each Muse without a new human prompt, restart/replay without duplicate replies, credential expiry and renewal, revoke, pause, block, infected-file denial, and unauthorized tenant denial. Record the approval required for every Muse send operation. Meta's [connector guidelines](https://muse.ai/platform/docs) require a fresh human approval for sensitive writes; if it classifies Envoi replies that way, fully unattended Muse-to-Muse exchange is not yet achievable under that policy. Respect the provider decision rather than bypass it.

## Meta connector submission decision

Prepare a reviewed connector with narrow `check_work`/`read_case` tools and separate write tools, clear read/write/sensitive classifications, an OAuth-based account link, privacy and retention documentation, a test tenant, and end-to-end evidence. Submit it once Meta confirms the intended wake channel and the owner approves the public submission and its terms. Approval of a connector alone must not be represented as approval of proactive wake.
