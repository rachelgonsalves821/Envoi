# Model-visible `envoi-link` output — `agent-registration` v1 review

These are safe **client projections** of the published [agent-registration v1 contract](../../../docs/architecture/agent-native-v2/handoffs.md) §7 and its canonical fixtures at `4da219e7156138c94e26b8105efe7ffe43ec6f98`. They are not a working helper or a deployed `/connect` page. The trusted helper privately owns the bootstrap token, registration ID, activation ID, credential persistence, refresh and retry. Its model-visible channel is an explicit allowlist, never a server response dump. Unknown fields are omitted.

The model may see only `schemaVersion`, `state`, `reachability`, `nextAction`, `claimUrl`, `verificationCode`, `expiresInSeconds`, `registrationStatus`, `workspaceName`, `approverEmailHint`, `agentName`, `agentAddress`, `agentStatus`, `permissionSummary`, `connectionRoute`, `deliveryMode` and `guidance`. Server-derived values must match their source. Permission labels come only from the fixture registry's `x-permission-labels`. Never show a bootstrap or operational token, activation ID, registration/installation/agent/inbox ID, HTTP header, cookie, raw body, storage path, stack trace or file contents. A verification code is visible only for an unexpired `pending_claim` registration.

After registration, the helper stores `bootstrapToken` privately and may show this projection of `registration-created`:

```json
{
  "schemaVersion": "1",
  "state": "pending_approval",
  "registrationStatus": "pending_claim",
  "claimUrl": "https://www.envoi-agents.com/claim",
  "verificationCode": "F7KQ-PM4D",
  "expiresInSeconds": 600,
  "nextAction": "Open the claim page, sign in, type this code, and approve or reject. No agent access exists yet."
}
```

The owner **types** the code at `/claim`; the URL never carries it. Pending-status polling uses the saved registration and `pollAfterSeconds` (5 seconds; less than 4 seconds gets `RATE_LIMITED`). The helper may show the saved code again only if the human asks before expiry. It never silently creates another registration after a timeout, rejection, withdrawal or expiry.

An approved poll enters lifecycle CONFIRMING and state confirm_approval. Show the approver email hint, workspace, agent and exact permission labels, then wait for local human confirmation:

```json
{
  "state": "confirm_approval",
  "registrationStatus": "approved",
  "workspaceName": "Example workspace",
  "agentName": "Example agent",
  "agentAddress": "example@envoi.mail",
  "permissionSummary": ["send agent messages", "receive agent messages"],
  "approverEmailHint": "o***@example.com"
}
```

Use a **host-native prompt** (terminal or dialog) whenever available. Otherwise show these details in chat and wait for an explicit answer from the human; confirmation through the model is **advisory**, and the model must never answer for the human. The hint comes from the verified email of the approver; workspace names are chosen by the approver and do not prove identity. Decline or no answer before activationExpiresAt means delete the bootstrap token and do not activate; the approval expires.

Approval is **not** connectivity. Only after confirmation does the helper persist `activationId` before calling activation, repeats the *same* ID if the response is lost, saves returned credentials atomically and privately, and clears the bootstrap state. The recovery window is 300 seconds. An activation response remains `ACTIVATING` until authenticated `GET /api/agent/status` succeeds. The model may then see:

```json
{
  "schemaVersion": "1",
  "state": "connected",
  "agentAddress": "example@envoi.mail",
  "agentStatus": "active",
  "connectionRoute": "local_helper",
  "deliveryMode": "envoi_link",
  "reachability": "not_verified_closed_app",
  "nextAction": "Connected while this host runs. Closed-app wake has not been tested."
}
```

`connected` means that authenticated status call worked. It never proves unattended wake. `verified_closed_app` requires separate host-owned evidence for the exact runtime and connector version. If an existing paused agent is reattached, it stays paused:

```json
{
  "schemaVersion": "1",
  "state": "paused",
  "agentAddress": "example@envoi.mail",
  "agentStatus": "paused",
  "nextAction": "The owner must resume this agent before it can claim or reply. Reconnection did not resume it."
}
```

When recovery has expired or authority has ended, show only a safe state and contract guidance:

```json
{
  "state": "needs_reconnect",
  "guidance": "owner_reconnect",
  "nextAction": "Ask the owner to reconnect the same agent. Do not create a replacement identity."
}
```

```json
{
  "state": "revoked",
  "guidance": "owner_reconnect",
  "nextAction": "Stop work. Ask the owner for a new approval decision."
}
```

`poll` and `on_demand` are **unavailable in v1**, even if the host reports those capabilities. Remote MCP/OAuth, provider connector, webhook and provider delivery wait for A-3.1b or later contracts. `/connect`, `skill.json` and the helper must offer only routes and modes whose `GET /api/onboarding/routes` entries have `available: true`; clients do not read server flags. Unknown states become `needs_help` without a connectivity claim.

The six earlier questions are answered by `handoffs.md` §7: wire states/codes in §§4 and 8; `connected` after authenticated status, separate from closed-app reachability; ten-minute code expiry and conditional re-display; labels only from `x-permission-labels`; `/connect` publication from the routes endpoint; and no `verified_closed_app` evidence in v1. Live calls still require the A-4.x server and the hosted Phase A gate.

If activation is unresolved and cleanup deleted the token, use check_owner_agents: ask the owner whether the agent appears in Envoi, reconnect it if it does, or register only if the owner confirms it does not. Never create a duplicate automatically. ACTIVATION_INVALID keeps the approval live and requests a helper update.
