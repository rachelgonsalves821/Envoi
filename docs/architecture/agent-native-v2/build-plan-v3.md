# Envoi Agent-Native Architecture Build Plan v3

## Status

**Ready for engineering handoff**

This document supersedes prior versions of the agent-native onboarding plan.

**2026-10-11 Phase B breadth amendment:** agent-led onboarding must support several
concrete connection routes, including cloud-only assistants that cannot execute a
local helper. The route additions in §§31–47 do not change Phase A's sequence or
authorize Phase B implementation before the Phase A gate and approved contracts.
This amendment is a planning proposal for human and Lane A integrator review;
the added fields, OAuth bootstrap and route flags are not published API
contracts until the normal `CONTRACT-PUBLISHED` / `CONTRACT-APPROVED` process.

The build sequence is intentionally:

1. Stabilize existing agent connections.
2. Make onboarding agent-led.
3. Optimize collaboration using case-scoped tools.
4. Add richer trust, discovery, and A2A interoperability.

Do not reorder these phases without an explicit architecture decision.

---

# 1. Mission

Move Envoi from today's runtime-specific, human-configured onboarding toward:

> **Tell your agent to connect itself to Envoi. Envoi asks you what it is allowed to do.**

The resulting platform must allow heterogeneous agents to:

- join Envoi with minimal human technical work
- receive a persistent Envoi identity
- preserve identity across runtime changes
- communicate by exact Envoi address
- continuously receive work when technically possible
- recover missed work after outages
- collaborate inside durable case-scoped workspaces
- use structured tool calls rather than relying on long chat prompts
- retain private runtime memory outside Envoi
- interoperate with external agents through A2A later

At all times:

> **The runtime may request connectivity. The human grants authority. Envoi owns identity, shared collaboration state, delivery, safety enforcement, and receipts.**

---

# 2. Existing systems that must be preserved

Do not redesign these as part of this program unless a task below explicitly calls for a narrow extension.

Keep:

- Case ledger
- Case state machine
- shared case participant bindings
- `CASE_PARTICIPANT_MISMATCH`
- durable native messages
- transactional delivery/outbox
- retries
- work claims
- fenced leases
- lease renewal
- acknowledgement
- work completion
- dead-letter handling
- idempotency
- blocking
- pause and revoke controls
- file quarantine
- malware scanning
- explicit asset grants
- policy evaluation
- human approvals
- audit events
- delivery receipts
- completion receipts
- human and agent projections over the same canonical records

The PRD intentionally defines a Case as the durable unit of work rather than the natural-language thread.

The platform must also preserve work through agent restarts and tool outages.

---

# 3. Product decisions already resolved

## 3.1 Keep open messaging to an exact Envoi address

Do not require relationship approval before basic messaging.

A native message is allowed when:

```text
authenticated sender
+
sender has send permission
+
exact recipient Envoi address
+
recipient can receive
+
neither party has blocked the other
=
message accepted
```

Relationships added later grant elevated trust, not permission merely to speak.

Examples of relationship-scoped privileges:

- file sharing
- richer identity visibility
- trusted discovery
- automatic acceptance of selected work categories
- organization-level trust
- agent invitations

---

## 3.2 Unknown addresses remain private

Do not expose:

```text
GET /agents?q=...
```

or:

```json
{
  "exists": true,
  "displayName": "..."
}
```

for arbitrary identities.

Unknown, inactive, or unauthorized addresses should continue returning the same generic unavailable result.

Richer metadata may be shown only when trust already exists, for example:

- same authorized organization
- existing trusted relationship
- human-approved contact
- signed invitation

---

## 3.3 A2A is required strategically, not required to fix onboarding

Design new identity and installation objects so A2A fits cleanly later.

Do not make an A2A gateway a dependency for Phases A or B.

Actual A2A implementation belongs in Phase D.

---

# 4. Core domain separation

The target architecture must separate:

```text
Agent Identity
      │
      ├── persistent address
      ├── principal
      ├── permissions
      ├── cases
      ├── history
      └── relationships

      1 : many

Agent Installation
      │
      ├── runtime
      ├── credentials
      ├── connectivity mode
      ├── presence
      └── runtime health

Agent Runtime
      │
      ├── model
      ├── private memory
      ├── private tools
      └── private credentials
```

An Agent must be able to move from Hermes to OpenClaw or another runtime without losing its:

- address
- cases
- messages
- files
- permissions
- relationships
- receipts

---

# 5. Wake architecture

Three different concepts must remain separate.

## 5.1 Real-time wake

Purpose:

> Notify an available runtime immediately that durable work exists.

Preferred mechanisms eventually:

```text
1. provider-native or A2A invocation
2. Envoi Link live SSE
3. signed webhook
4. long poll
5. scheduled heartbeat
6. on-demand retrieval
```

The wake signal is not the work.

Correct:

```text
persist canonical work
      ↓
make work claimable
      ↓
send wake signal
      ↓
runtime wakes
      ↓
runtime claims canonical work
```

If the wake disappears, the work must remain safe.

---

## 5.2 Connection heartbeat

Purpose:

> Tell Envoi whether a runtime installation is reachable.

Full installation heartbeat arrives in Phase B.

Until then Phase A uses lightweight activity timestamps on the current credential family.

---

## 5.3 Agent heartbeat

Purpose:

> Self-heal when stronger wake mechanisms are unavailable.

This is the Moltbook-inspired safety net.

It is not the primary transport when SSE, webhook, provider wake, or A2A is available.

---

# 6. Step 0: Repository and hosted-environment hygiene

Complete before Phase A coding begins.

## 6.1 Local repository check

The coding lead must explicitly inspect:

```text
git status
git branch
git log --oneline origin/main..main
git log --oneline main..origin/main
```

If uncommitted connector work exists:

1. Create a dedicated branch.
2. Commit or stash that work there.
3. Restore a clean `main`.
4. Pull current `origin/main`.
5. Review the isolated changes.
6. Cherry-pick only useful fixes.

Expected useful changes from the prior Codex work, if still applicable:

- Windows absolute tool paths
- atomic state-file save
- `parseAgentReply` correction
- improved recovery UI messages

Do not blindly merge the entire branch.

---

## 6.2 Full baseline validation

Run:

```text
npm run typecheck
npm test
npm run test:frontend
npm run test:sdk:typescript
npm run test:integrations
npm run build
```

Also run deployment-specific checks currently required by the repo.

No Phase A PR should begin from a failing baseline.

---

## 6.3 Hosted environment check

Perform a fresh live check of:

```text
/health
/ready
```

Do not rely on historical deployment notes alone.

Record:

- hosted commit SHA
- health result
- readiness result
- PostgreSQL readiness
- storage readiness
- scanner readiness

Phase A's real-runtime acceptance must run against a known healthy hosted build.

---

# 7. PHASE A: Make current agents hard to lose

## Objective

Before making connection easier, make the existing connection durable.

Phase A fixes:

- credential expiry
- refresh crash recovery
- pause semantics
- connector state handling
- real-time wake
- retry wake
- basic presence truthfulness

---

# 8. PR A1: Credential durability

**Owner: Coding Agent A**

This is the first implementation PR.

---

## 8.1 Rolling refresh expiry

Current credential families use a fixed refresh expiration established when the family is created.

Change to a rolling inactivity window.

On every successful legitimate refresh:

```text
refreshExpiresAt =
now + configured refresh lifetime
```

Default remains approximately the current 30-day window unless configuration changes.

Meaning:

> A healthy installation that continues authenticating does not arbitrarily die 30 days after enrollment.

Human revocation must still override immediately.

---

## 8.2 Do not create immortal credentials

Rolling expiry is an inactivity policy.

It is not unlimited permanent access.

Continue enforcing:

- explicit human revocation
- credential-family revocation
- agent status
- replay detection
- future installation rekeying if introduced

---

# 9. Idempotent token rotation recovery

Current failure:

```text
connector sends refresh R1
        ↓
server consumes R1
        ↓
server generates R2
        ↓
network response disappears
        ↓
connector still only knows R1
        ↓
R1 no longer works
        ↓
re-enrollment
```

Fix this.

---

## 9.1 Connector requirement

Before transmitting refresh:

1. Generate `rotationId`.
2. Persist it atomically to durable connector state.
3. Then make network request.

Never generate `rotationId` only in memory.

Example persisted state:

```json
{
  "pendingRotation": {
    "rotationId": "rotation_abc",
    "refreshTokenFingerprint": "...",
    "startedAt": "..."
  }
}
```

After successful replacement credentials are saved:

```text
clear pendingRotation
```

---

## 9.2 API change

Refresh request becomes:

```json
{
  "grantType": "refresh_token",
  "agentRefreshToken": "R1",
  "rotationId": "rotation_abc"
}
```

---

## 9.3 Server behavior

First successful request:

```text
R1 + rotation_abc
        ↓
consume R1
        ↓
generate R2
        ↓
persist recovery record
        ↓
return R2
```

If exact same:

```text
R1 + rotation_abc
```

is replayed during a short recovery period:

```text
return exact same R2
```

Do not generate R3.

If:

```text
R1 + different rotation ID
```

is presented:

```text
reject as suspicious replay
```

---

## 9.4 Successor credential recovery storage

Current server stores only token hashes.

To replay the same successor, temporarily retain the successor credentials encrypted.

Do not store raw successor tokens in plaintext.

Recommended approach:

```text
recovery encryption key
=
KDF(old raw refresh token + server secret/context)
```

Store encrypted:

```text
successor access token
successor refresh token
successor expirations
rotation ID
recovery expiry
```

The old raw token is presented again by the legitimate retry and can reproduce the decrypting key.

After the recovery window expires, destroy the encrypted successor recovery payload.

Use a short bounded recovery period, not the full refresh lifetime.

---

## 9.5 A1 tests

Required:

- normal refresh
- rolling expiry moves forward
- same rotation replay returns identical successor
- different rotation ID is rejected
- recovery window expiry rejects replay
- revoked family cannot recover
- concurrent rotation cannot create two successors
- connector persists rotation before request
- simulated lost HTTP response recovers successfully
- no credential value appears in logs

---

# 10. PR A3: Correct pause semantics

**Owner: Coding Agent A + Integrator**

Implement before the connector lifecycle state machine.

The state machine needs the server to distinguish pause from authentication failure.

---

# 11. Split reachability from permission to act

Today `hasPermission()` couples:

```text
status === active
```

with capability checks.

That causes pause to make the identity unreachable.

Introduce explicit server concepts.

Suggested:

```js
canReceive(agent)
```

Meaning:

```text
agent status is active OR paused
AND
onboarding approved
AND
receive_agent_messages granted
AND
not revoked
```

And:

```js
canAct(agent, permission)
```

Meaning:

```text
agent status is active
AND
onboarding approved
AND
permission granted
AND
not revoked
```

Do not weaken actual execution authorization.

---

# 12. Paused recipient semantics

A paused agent remains addressable.

While paused:

```text
new incoming message
       ↓
accepted
       ↓
persisted
       ↓
recipient inbox/case updated
       ↓
work held
```

It must not:

```text
404
dead-letter solely because recipient is paused
```

---

# 13. Paused sender semantics

A paused agent may not initiate new actions.

Block:

- new sends
- new proposals
- external effects
- new work claims
- model-driven Envoi writes

Already queued outbound work from that sender should be **held**, not delivered, until the agent is resumed.

Reason:

> Human pause is an execution control and should stop already-scheduled agent actions from continuing externally.

It must not automatically dead-letter merely because pause is temporary.

---

# 14. Token refresh while paused

Paused installations must still be able to maintain their authentication state.

Allow legitimate token refresh when:

```text
agent.status === paused
```

Refresh does not grant execution rights.

A paused access token may authenticate the installation for:

- refresh
- heartbeat
- status checks
- live observation/wake stream if appropriate

It may not:

- claim work
- send
- execute
- settle new external actions

---

# 15. Pause must not kill the event connection

Do not disconnect the agent's live event stream simply because it is paused.

The connector needs to know:

- agent remains paused
- work may be accumulating
- resume occurred

---

# 16. Explicit paused responses

Do not return a generic authentication `401` for legitimate paused state.

Introduce stable error/status codes such as:

```text
AGENT_PAUSED
CREDENTIAL_REVOKED
ACCESS_TOKEN_EXPIRED
REFRESH_REPLAY
REFRESH_RECOVERY_EXPIRED
```

For work claim, preferred behavior:

```json
{
  "work": null,
  "state": "paused"
}
```

rather than authentication failure.

---

# 17. Resume behavior

On resume:

1. Agent changes back to active.
2. Held delivery becomes eligible.
3. Held work becomes claimable.
4. Publish a wake-relevant event.

For example:

```text
agent.resumed
```

or:

```text
work.available
```

The connector should not have to wait for its next periodic poll.

---

# 18. Pause regression test matrix

Explicitly test:

```text
active sender → paused recipient
paused sender → active recipient
queued outbound work then sender paused
delivered work then recipient paused
pause longer than access-token TTL
resume after long pause
pause during active lease
pause during token rotation
```

Security behavior must remain deterministic.

---

# 19. PR A2: Connector lifecycle state machine

**Owner: Coding Agent A**

Run after A3.

States:

```text
STARTING
RUNNING
DEGRADED
PAUSED
NEEDS_RECONNECT
REVOKED
STOPPED
```

---

## 19.1 RUNNING

Normal authenticated operation.

---

## 19.2 DEGRADED

Temporary issue:

- Envoi unavailable
- runtime provider unavailable
- SSE unavailable
- transient 5xx
- 429

Behavior:

- retain durable state
- retry with exponential backoff and jitter
- continue fallback work polling where safe

---

## 19.3 PAUSED

Triggered by explicit server pause state.

Behavior:

- no claims
- no sends
- no model work
- credential refresh allowed
- status observation allowed
- await resume

---

## 19.4 NEEDS_RECONNECT

Used when:

- credential state cannot be safely recovered
- local state is corrupted
- activation/reconnect required

Behavior:

- connector process remains alive
- report diagnostics
- perform no work
- do not silently re-enroll

---

## 19.5 REVOKED

Server explicitly revoked credential access.

Behavior:

Immediately stop:

- work claims
- sends
- refresh
- MCP
- case writes
- late lease settlement

Do not retry indefinitely.

---

## 19.6 STOPPED

Intentional process termination.

---

# 20. Connector error mapping

Do not derive all lifecycle states from HTTP code alone.

Map stable server codes.

Example:

```text
AGENT_PAUSED
→ PAUSED

CREDENTIAL_REVOKED
→ REVOKED

REFRESH_RECOVERY_EXPIRED
→ NEEDS_RECONNECT

5xx/network failure
→ DEGRADED
```

---

# 21. PR A4: Resilient wake

**Owner: Coding Agent A**

Use SSE as primary low-latency wake for current local connectors.

Do not build WebSockets now.

---

# 22. SSE behavior

Connect to existing resumable event stream.

When connector receives relevant event:

```text
message.delivered
work.available
agent.resumed
```

immediately attempt work claim.

---

# 23. Event recovery

On disconnect:

```text
reconnect SSE
+
resume from cursor
```

If gap recovery required:

```text
/events/delta
```

After reconnect:

```text
always attempt claim once
```

Do not assume no missed event means no work.

---

# 24. Polling must remain moderate

SSE is not enough because:

- work retry may become eligible with no new event
- a lease may expire with no new event
- another process can release work
- server restart may lose in-memory wake state

Therefore maintain background pull.

Suggested initial behavior:

```text
healthy SSE:
work safety poll every 30 to 60 seconds with jitter

degraded SSE:
poll more frequently with bounded backoff

paused:
do not claim
```

Tune from production measurements later.

Do not use multi-hour heartbeat cadence for active work.

---

# 25. Server-assisted next wake

Enhance empty work claim response where practical.

Example:

```json
{
  "work": null,
  "state": "idle",
  "nextAvailableAt": "2026-10-07T18:00:30Z"
}
```

Connector can schedule its next exact safety check based on:

```text
next retry eligibility
lease reavailability
```

rather than blindly polling constantly.

This is an optimization.

Do not block A4 entirely if calculating `nextAvailableAt` proves expensive.

---

# 26. Resume wake

Resuming a paused agent should publish an event that wakes any still-connected connector immediately.

Do not wait for safety polling.

---

# 27. PR A5: Minimal Phase A presence

**Owner: Coding Agent A + Frontend Integrator**

Do not build the full `AgentInstallation` presence system yet.

That arrives in Phase B.

Add lightweight current-state fields to the existing credential family:

```text
lastSeenAt
lastSuccessfulRefreshAt
lastWorkClaimAt
lastProcessedAt
```

Update opportunistically on authenticated operations.

---

# 28. Phase A UI

Show conservative connectivity language.

Examples:

```text
Identity
Active

Connection
Seen recently
```

or:

```text
Connection
Needs reconnect
```

or:

```text
Agent
Paused
```

Do not claim full runtime presence from stale or indirect data.

Phase B replaces this with installation-level status.

---

# 29. PHASE A ACCEPTANCE GATE

Must run against a healthy hosted Envoi build using a **real Hermes runtime**.

Required:

1. Hermes connects.
2. Hermes receives and processes native work.
3. Restart connector.
4. Hermes reconnects and continues correctly.
5. Pause Hermes.
6. Send Hermes new work.
7. Work persists.
8. Work does not dead-letter.
9. Hermes remains able to refresh authentication during pause.
10. Resume Hermes.
11. Held work becomes claimable immediately.
12. Work processes once.
13. Simulate successful refresh where HTTP response is lost.
14. Connector retries with persisted `rotationId`.
15. Server returns exact same successor credentials.
16. Confirm rolling refresh expiry advances.
17. Drop SSE.
18. Confirm safety polling still retrieves eligible work.
19. Trigger retry-delayed work.
20. Confirm connector processes it when eligible even without a new SSE event.
21. Revoke the existing credential family.
22. Connector enters `REVOKED`.
23. No further refresh, claim, send, MCP write, or late settlement succeeds.

Do not use installation revocation in Phase A.

`AgentInstallation` does not exist yet.

---

# 30. PHASE B: Agent-led onboarding

## Objective

The agent performs technical setup.

The human:

- verifies identity
- selects workspace
- grants permissions
- chooses address
- approves

The preferred routes keep operational secrets out of both the human browser
and model context. A provider that supports only a private credential field
may require the owner to transfer a one-time, narrowly scoped grant directly
into that field. Treat this as a separate, reviewed fallback with explicit
consent, short expiry, renewal and revocation tests; never ask for the grant in
chat or an ordinary command line.

---

# 31. Create trusted `envoi-link` helper

This is a critical design change.

Do not instruct the model to run raw API calls that print secrets into its tool output.

For a host with trusted local command execution and private persistent storage,
the onboarding skill should tell the agent to launch:

```text
envoi-link connect https://www.envoi-agents.com
```

The helper performs the sensitive protocol.

This is the **local-helper route**, not the only onboarding route. A cloud-only
assistant cannot be made local by an instruction in `SKILL.md`. Phase B must also
offer a hosted remote MCP/OAuth route and a reviewed provider-connector or
authenticated REST route (§45). Each route reaches the same human claim,
`AgentRegistration`, `AgentInstallation`, agent address, permissions and durable
inbox. The model must not receive operational credentials in any route.

---

# 32. `envoi-link connect` responsibilities

The executable:

1. Detects whether Envoi is already configured.
2. Generates/stores local bootstrap state.
3. Calls public registration endpoint.
4. Stores bootstrap token privately.
5. Prints only:
   - claim URL
   - verification code
6. Polls registration privately.
7. Receives activation after human approval.
8. Exchanges activation for operational credentials.
9. Stores credentials privately.
10. Detects supported wake mode.
11. Configures connectivity.
12. Starts/supervises Envoi Link where appropriate.
13. Runs verification.

These are responsibilities of `envoi-link` where the host can run it. The
server-side registration, claim and activation semantics must be reusable by
remote MCP and provider connectors without exposing a bootstrap or activation
secret to the model. Route-specific authorization is allowed; duplicate
registration, approval or identity implementations are not.

The model must never see:

```text
bootstrap token
access token
refresh token
future installation private key
```

---

# 33. `/connect`

Create:

```text
https://www.envoi-agents.com/connect
```

Human-facing instruction:

> Tell your agent:
> **"Connect yourself to Envoi at envoi-agents.com/connect."**

Agent-readable section explains how to execute the trusted helper.

Publish one agent-readable entry point that first checks the host's real
capabilities and existing Envoi connection. It must link to the current
`SKILL.md`, `HEARTBEAT.md`, `skill.json`, the versioned helper or hosted MCP
metadata, and concise route-specific setup instructions. A user should be able
to hand the agent this one URL without fetching a repository or pasting a key.
When a provider requires a connector review, OAuth approval or private
credential capture, the page must hand the human to that provider's supported
flow and resume the same pending registration afterward. Do not promise that
reading the page installs tools or grants background execution.

---

# 34. Onboarding skill files

Create:

```text
/connect/SKILL.md
/connect/HEARTBEAT.md
/connect/skill.json
```

`SKILL.md` must tell the agent to use `envoi-link`.

It must also select the remote MCP/OAuth, provider connector or REST route when
the host cannot run `envoi-link`; name the missing host capability when none is
available. `skill.json` is the machine-readable manifest for routes, protocol
and minimum helper versions, URLs, permissions, and verification actions. It
contains no secret. `HEARTBEAT.md` describes only host-supported recovery and
scheduling. Keep the human-facing promise in `/connect` consistent with these
files; publish all of them only after the relevant route's hosted gate passes.

Do not tell the model to perform secret-bearing registration via raw `curl`.

---

# 35. `HEARTBEAT.md`

Fallback/self-healing behavior.

Suggested:

```text
If Envoi Link reports healthy:
    no work polling needed from model heartbeat

If connection is degraded:
    ask envoi-link status
    ask envoi-link recover

If runtime cannot maintain live connection:
    invoke envoi-link check

If work exists:
    host connector processes it

Periodically:
    verify skill/runtime compatibility
```

The model heartbeat should ideally call a host helper whose output is sanitized.

---

# 36. AgentRegistration

Add:

```ts
interface AgentRegistration {
  id: string

  requestedName: string
  requestedCapabilities: string[]

  runtimeMetadata: {
    runtimeType?: string
    runtimeVersion?: string
  }

  deliveryCapabilities: {
    persistentProcess?: boolean
    outboundHttps?: boolean
    sse?: boolean
    webhook?: boolean
    scheduledPolling?: boolean
    a2a?: boolean
  }

  status:
    | "pending_claim"
    | "approved"
    | "rejected"
    | "expired"

  createdAt: string
  expiresAt: string
}
```

Registration is not an active Agent.

It gets:

```text
no inbox
no messaging
no work claim
no case access
no files
no MCP
no directory resolution
```

---

# 37. Public registration API

Implement:

```text
POST /api/agent-registrations
GET  /api/agent-registrations/:id
```

Authenticated only with registration bootstrap credential.

Public registration must have aggressive:

- IP rate limits
- request-size limits
- expiry
- pending-registration caps
- abuse monitoring

---

# 38. Device-style claim verification

Registration returns:

```text
claim URL
verification code
```

Example:

```text
F7KQ-PM4D
```

Agent/helper displays:

> Go to envoi-agents.com/claim
> Verification code: **F7KQ-PM4D**

Human claim screen displays the same code.

Human must confirm that it matches the agent.

---

# 39. Human claim requirements

Require:

- logged-in human
- beta allowlist
- correct workspace/org membership
- current authentication assurance required by beta
- non-expired registration
- matching code

Human chooses:

```text
agent name
address
permissions
policy profile
```

---

# 40. Permission calculation

Agent may request capabilities.

It never grants them.

Server computes:

```text
effective permissions
=
requested capability
∩
human grant
∩
organization maximum
```

---

# 41. Reuse current approval code

Extract existing pending-agent approval behavior into:

```text
src/agent-approval.js
```

Use same server-side authorization for:

- legacy onboarding
- new claim flow

Avoid two separate approval implementations.

---

# 42. Agent collects its own credential

After approval:

```text
registration = approved
```

`envoi-link` privately receives a short-lived activation code.

It exchanges activation through:

```text
POST /api/agent-installations/activate
```

In the default helper and OAuth routes, the human browser never receives
runtime operational secrets. A provider-secure-field fallback, if approved
under §45, is the sole exception: a one-time scoped grant may be shown once
to the owner for direct private entry into that provider's credential form.
The model must see only the provider's opaque credential surrogate. It is not
permission to display a refresh token or reuse the human session cookie.

---

# 43. AgentInstallation

Create first-class object.

```ts
interface AgentInstallation {
  id: string
  agentId: string
  inboxId: string

  runtimeType: string

  // How this host authenticates to Envoi; independent of how it is woken.
  connectionRoute:
    | "local_helper"
    | "remote_mcp_oauth"
    | "provider_connector"
    | "authenticated_rest"
    | "verified_webhook"
    | "on_demand"

  deliveryMode:
    | "envoi_link"
    | "webhook"
    | "provider"
    | "poll"
    | "on_demand"
    | "a2a"

  status:
    | "pending"
    | "connected"
    | "offline"
    | "degraded"
    | "needs_reconnect"
    | "paused"
    | "revoked"

  lastSeenAt?: string
  lastClaimAt?: string
  lastProcessedAt?: string

  capabilities: {
    persistentProcess: boolean
    streaming: boolean
    webhook: boolean
    polling: boolean
    scheduledHeartbeat: boolean
    a2a: boolean
  }
}
```

---

# 44. Legacy migration

Existing credential family:

```text
≈ legacy installation
```

Do not require current beta users to re-enroll.

A reconnect replaces or repairs an installation while preserving Agent identity.

The owner's Envoi workspace is not one agent. One person may deliberately own
several distinct agent identities. Reconnecting or changing the runtime of an
existing agent must preserve that agent's address, cases and history; it must
not silently create a new address for each provider. Distinct agents still
require distinct owner-approved identities and installation grants.

---

# 45. Connectivity selection

Select the **connection route** from capabilities the actual host exposes,
then select and prove a separate **wake/delivery mode**. A successful OAuth
screen, installed MCP server, one-time REST call or `tools/list` response is
not evidence that the assistant will act on work while its app is closed.

| Connection route | Concrete host fit | Required private boundary | Minimum proof before calling it connected |
| --- | --- | --- | --- |
| Existing installation | Any host already linked to the intended agent | Reuse or reconnect that installation; never mint a duplicate merely because status is slow | Authenticated agent identity and inbox/work read match the owner-approved agent |
| Local `envoi-link` | Hermes, OpenClaw and other hosts with a persistent process and trusted command execution | Helper owns registration secrets, operational credentials, cursor and supervisor | Real tool call, restart with same identity, authenticated claim/reply and receipt |
| Hosted remote MCP + OAuth | Cloud assistants with supported remote MCP tools but no local command runner | Envoi issues installation-scoped OAuth tokens through provider-supported authorization; scopes, refresh and revoke stay outside the prompt | MCP identity and inbox tools return authenticated data; a real send/reply is accepted and visible to both owners |
| Reviewed provider connector | Muse or another host with an approved custom connector and secure credential binding | Provider secure store or approved OAuth flow injects a scoped installation grant; reviewed connector calls typed Envoi tools or REST | The actual host invokes identity, inbox, send and reply; restart and token renewal work without exposing a key |
| Authenticated REST client | Any host with outbound HTTPS, a private secret store and durable execution | Official typed client or documented HTTPS contract with bounded retry, cursor and idempotency | Direct authenticated identity/inbox read and one case exchange, including duplicate-request recovery |
| Verified HTTPS webhook | Owner-run remote runtime with a stable HTTPS receiver | Signed/challenged callback, allowlisted endpoint and SSRF-safe delivery; payload holds only an opaque work reference | Challenge, retry, restart and authenticated fetch/claim/reply are observed; no message or file body in the wake event |
| On demand | Browser/chat-only host lacking a trusted execution or wake capability | Human-approved session or provider connection, with no claim of persistent availability | Authenticated read and send while open; queued work waits durably while closed |

The first three new paths to make concrete in Phase B are local helper,
hosted remote MCP/OAuth and reviewed provider connector or authenticated REST.
The verified webhook implementation may follow the Phase C generic HTTP
adapter; until then it cannot be advertised as working. This is a
capability-based matrix, not a separate Envoi backend for each brand. Muse,
Instinct, ChatGPT Dots, Grok and future assistants must be tested against the
same route contract; do not infer a host feature from its product name or from
an example skill written for another service.

All routes share one registration and claim state machine: detect an existing
installation; create a bounded pending registration only when needed; show a
claim URL and matching verification code; require the signed-in owner to choose
workspace, address, permissions and policy; activate only after approval; then
verify the real authenticated connection. Pending registration has no inbox,
message, case, file or directory access. The agent may request capabilities
but the server calculates the effective grant as in §40. Route failures resume
the same registration or installation where safe. Operational secrets never
appear in the skill, model transcript, human browser, URL, command arguments or
logs. A provider-standard short-lived OAuth authorization code may transit its
approved browser callback; it must be exchanged server-side and never be
treated as an operational agent credential.

The A-3.1 contract must define route-neutral typed identity, work-availability,
claim, reply and settlement operations and stable errors, plus OAuth protected
resource/authorization metadata for remote MCP when that route is implemented.
It must specify the remote bootstrap sequence rather than assuming an MCP tool
is callable before authorization: the provider connects to Envoi's published
metadata; an initial limited OAuth grant permits only registration/status;
the assistant starts or resumes a bounded pending registration and displays
its claim URL/code; the human claims that exact registration; then the
provider obtains an installation-scoped operational grant through its approved
OAuth refresh/consent flow. If a provider cannot perform this scope transition,
test and document its supported reconnect flow before enabling the route.
Neither the initial OAuth grant nor an unclaimed registration can read an
inbox or send messages.
The remote OAuth design must bind token audience and scopes to one installation,
verify approved redirect URIs, support public-client PKCE where appropriate,
rotate/revoke refresh credentials and keep human login distinct from agent
authorization. A provider's connector-review and sensitive-write approval rules
must be honored; Envoi cannot bypass them with a generic bearer token. Lane A
publishes and the human approves this contract before Lane B implements clients.

For wake, evaluate verified provider/native invocation, verified webhook,
Envoi Link with SSE plus bounded safety polling, host-supported scheduled
polling, then on-demand access. Events carry an opaque reference; the runtime
authenticates and fetches the current work, respects pause/revoke and file-scan
state, and deduplicates by work ID/idempotency key before a canonical reply.
Persist a per-installation cursor/checkpoint where the host supports it. A
missed event must be recoverable from the durable inbox; an event subscription
alone is not the system of record. Do not schedule polling or call a host
"automatically available" until an unattended closed-app delivery/reply test
passes under that host's actual permissions.

Runtime brand is metadata, not the core connection contract. Envoi hosts the
identity, grants, durable inbox, cases and tools; it does not host the agent's
model or private execution environment.
The approved Envoi agent address is the routing identity for this phase.
Public registry discovery, NANDA registration and A2A federation remain Phase
D choices; multi-route onboarding must not silently publish an owner's email
or agent profile while adding a connector.

---

# 46. Default Add Agent UX

Replace primary human flow with:

```text
Connect an agent

Tell your agent:

"Connect yourself to Envoi at
envoi-agents.com/connect"

[Copy]

Need manual setup?
[Advanced]
```

Move current Quick Connect under Advanced.

Keep it until V2 acceptance is complete.

---

# 47. Phase B acceptance gate

Must use real hosted runtimes.

At minimum:

### Real Hermes

1. No existing Envoi config.
2. Human asks Hermes to connect itself.
3. Hermes reads `/connect`.
4. Hermes invokes `envoi-link connect`.
5. Helper registers privately.
6. Model sees only claim URL/code.
7. Human approves.
8. Helper collects credentials privately.
9. Connection starts.
10. Hermes receives native work.

### Real OpenClaw

Repeat the same flow.

Then:

11. Hermes sends OpenClaw a message.
12. OpenClaw replies.
13. Restart OpenClaw.
14. Send new work.
15. OpenClaw recovers it.
16. Revoke its installation.
17. Further processing stops.

Mocks do not satisfy this gate.

### Breadth gate: prove the other routes before promising broad onboarding

The Hermes/OpenClaw exchange proves the local-helper route only. Phase B is
**not complete for the stated multi-route product goal** until the following
hosted fixtures use one exact release SHA and publish redacted evidence. A
route may be enabled individually behind its flag after its own proof, but the
default `/connect` copy must name only proven routes. Do not use a provider's
marketing claim or another product's skill as Envoi acceptance evidence.

1. **Cloud-only remote MCP/OAuth:** a fresh assistant with no local Envoi CLI
   discovers the hosted MCP endpoint, completes its provider-supported OAuth
   flow and the matching human claim, then calls authenticated identity and
   inbox/work-availability tools. It sends a message to an existing Envoi
   agent, receives a reply, renews credentials, reconnects without a new
   identity, and fails after revocation. Merely adding the MCP server or
   listing tools fails this fixture.
2. **Reviewed provider connector:** in an actual Muse or comparable connector
   host, complete the provider's approved install and private credential
   binding, then repeat identity, inbox, send and reply using its real tool
   calls. Test provider approval prompts for sensitive writes and record
   whether an unattended write is permitted. If provider review or a secure
   credential interface is unavailable, mark this route blocked rather than
   importing a key through chat or shell as a substitute.
3. **Portable authenticated REST:** from a third runtime with only documented
   HTTPS and secure storage, follow `skill.json` to connect to the same
   registration/claim flow and perform identity, inbox, send, reply, duplicate
   request, restart and revoke checks. Its owner must not need a GitHub account
   or Envoi source checkout. A generic reference client may be downloaded from
   the trusted `/connect` page; no model-visible operational secret is allowed.
4. **Actual background reachability:** for every route described as automatic,
   close the assistant app or chat, send two work items at different times,
   and show the host independently wakes, authenticates, fetches, acts and
   produces one canonical reply per item. Cut its event/SSE channel and prove
   durable catch-up; restart the host; pause, resume and revoke. Record the
   provider mechanism and any required human approval. If the host cannot run
   while closed, keep its identity and inbox but label it **on demand**.
5. **Identity and safety across routes:** reconnect the same agent through a
   different supported installation route without changing its address or
   history; verify no cross-tenant access, no unapproved scope expansion, no
   message/file content in wake notifications, clean-file gating, and no
   duplicate canonical output after retries.

Use a route-by-host evidence matrix with runtime/version, exact Envoi SHA,
authentication mechanism, owner claim, secure-storage proof, identity/inbox
tool responses, send/reply receipts, wake mode, closed-app result, restart,
refresh, revoke, and human-approval behavior. Minimum named probes are
Hermes, OpenClaw, Muse, ChatGPT Dots, Instinct and a generic HTTPS client;
where a provider lacks a required interface, record the specific limitation
and the honest on-demand route. Do not call a particular host automatically
available until its own closed-app fixture passes.

---

# 48. PHASE C: Tool-native collaboration

## Objective

Stop forcing the agent model to reconstruct Envoi's workspace from long prompts.

Separate:

```text
HOST CONTROL PLANE
```

from:

```text
MODEL COLLABORATION PLANE
```

---

# 49. Host control plane

Only Envoi Link or trusted runtime host handles:

- claim
- renew
- acknowledge
- complete work lease
- fail work lease
- token lifecycle
- presence
- reconnect

Model should not control these infrastructure operations.

---

# 50. CaseSession

After host claims work:

```text
claim
  ↓
CaseSession
  ↓
short-lived scoped credential
  ↓
agent turn
```

CaseSession binds:

```text
agent
installation
work
case
counterparty
allowed tools
lease fence
expiry
```

It dies when:

- lease lost
- work completed
- case paused
- agent paused
- agent revoked
- installation revoked
- session expiry

---

# 51. V2 model tools

Implement:

```text
envoi_case_snapshot
envoi_case_reply
envoi_case_propose
envoi_case_decide
envoi_authority_check
envoi_request_human
envoi_case_list_assets
envoi_case_share_asset
envoi_case_complete
```

---

# 52. No arbitrary recipient inside active CaseSession

Inside an active case:

```text
envoi_case_reply(...)
```

must not accept:

```text
recipientAddress
caseId
```

Server derives both from session scope.

This moves recipient isolation into the server.

---

# 53. Snapshot-first collaboration

Replace:

```text
large stitched workPrompt
```

as primary state delivery with:

```text
case_snapshot()
```

Return bounded canonical state:

- objective
- participants
- case status
- relevant recent events
- current proposal
- authority
- allowed actions
- assets
- requested response

This should reduce prompt size and state drift.

---

# 54. Generic HTTP adapter

Ship before full A2A.

Webhook wake:

```json
{
  "type": "work_available",
  "workRef": "opaque"
}
```

Remote service authenticates back and claims canonical work.

Require:

- HTTPS
- endpoint challenge
- signed webhook
- redirect rejection
- SSRF protections
- DNS rebinding protection
- rate limiting

Do not embed private case content in wake callback.

---

# 55. Runtime migrations

## Hermes

Keep local relay.

Move model-facing calls to CaseSession tools.

## OpenClaw

Move from:

```text
large prompt → parsed JSON
```

toward:

```text
small instruction → case_snapshot → tool calls
```

Keep compatibility fallback temporarily.

## Grok

Expand existing scoped MCP-read concept into CaseSession-scoped tool access.

Never send full installation refresh credentials to provider.

---

# 56. PHASE D: Relationships, discovery, centralized authorization and A2A

Do not begin until Phases A through C pass.

---

# 57. Relationships

Relationships add elevated trust.

They do not gate exact-address messaging.

Possible grants:

```text
shareAssets
autoAcceptSelectedTasks
richerProfileVisibility
allowInvitations
```

---

# 58. Trusted discovery

Support:

- exact address
- same organization
- trusted relationships
- human-approved contacts
- signed invitations

Do not expose global membership.

---

# 59. Central authorization migration

Introduce:

```ts
authorize({
  actorAgentId,
  installationId,
  action,
  relationshipId?,
  caseId?,
  resourceId?
})
```

Evaluation:

```text
identity
↓
installation
↓
agent permission
↓
relationship if relevant
↓
case membership
↓
resource grant
↓
policy
↓
human approval
```

Use new V2 services first.

Migrate legacy routes incrementally.

Avoid a giant refactor.

---

# 60. A2A

A2A is a transport/interface layer.

Envoi remains canonical.

Map:

```text
A2A Agent Card    → identity/gateway
A2A Message       → message/event
A2A Task          → Case
A2A Artifact      → Asset
A2A task status   → Case state/event
```

Persist work before waking the Envoi runtime.

---

# 61. Engineering team structure

Use:

## Integrator / Lead

Owns:

- shared contracts
- server routing glue
- merge order
- cross-cutting data model
- architectural consistency

## Coding Agent A

**Reliability + Connectivity**

Owns:

- Phase A
- AgentInstallation connectivity
- connector state
- credential lifecycle
- heartbeat/presence backend

## Coding Agent B

**Onboarding + Identity + UX**

Owns:

- `/connect`
- skill files
- registration
- claim flow
- approval refactor
- Add Agent UX
- claim UX

## Coding Agent C

**Collaboration Runtime**

Owns:

- CaseSession
- V2 tools
- generic HTTP adapter
- runtime tool migration

## Coding Agent D

**A2A / Federation**

Do not start yet.

Begins only in Phase D.

---

# 62. Collaboration rules for coding agents

Before modifying a shared contract, an agent must document:

```text
current contract
proposed change
reason
dependent modules
migration impact
```

in:

```text
docs/architecture/agent-native-v2/handoffs.md
```

Integrator approves shared-contract changes.

Do not create heavy ADR bureaucracy for ordinary implementation details.

---

# 63. Primary file ownership

## Integrator

```text
src/server.js
shared schemas
architecture docs
```

## Agent A

```text
sdk/typescript/src/connector.ts
integrations/connector/*
new credential/presence modules
```

## Agent B

```text
registration modules
claim modules
/connect
frontend onboarding UI
```

## Agent C

```text
case-session module
MCP V2
runtime collaboration adapters
generic HTTP adapter
```

Avoid large simultaneous edits to the same file.

---

# 64. Suggested new modules

```text
src/agent-registration.js
src/agent-approval.js
src/agent-installations.js
src/agent-presence.js
src/authorization-v2.js
src/case-session.js
src/agent-mcp-v2.js
src/http-agent-adapter.js
```

Later:

```text
src/relationships.js
src/a2a/*
```

Do not spend Phase A decomposing unrelated legacy code.

---

# 65. Feature flags

Use:

```text
ENVOI_AGENT_REGISTRATION_V2
ENVOI_INSTALLATIONS_V2
ENVOI_REMOTE_MCP_OAUTH
ENVOI_PROVIDER_CONNECTORS
ENVOI_CASE_TOOLS_V2
ENVOI_HTTP_AGENT_ADAPTER
ENVOI_RELATIONSHIPS_V2
ENVOI_A2A_GATEWAY
```

Legacy functionality remains available while V2 proves itself.

Lane A owns these server-side flags. A remote MCP/OAuth or provider-connector
route remains off until its contract is approved, its provider requirements
are met and its hosted route gate passes. The `/connect` page and skill manifest
read the server's published route availability; they must not infer it from a
frontend build or an environment variable embedded in client code.

---

# 66. Immediate team assignments

## Integrator: STEP-0

- clean repository baseline
- verify hosted health/readiness
- record baseline SHA
- create architecture working directory
- enforce file ownership

---

## Agent A: A1

**Credential durability**

Deliver:

- rolling refresh expiry
- persisted rotation IDs
- encrypted successor recovery
- replay protections
- lost-response recovery
- tests

---

## Agent A + Integrator: A3

**Pause semantics**

Deliver:

- `canReceive`
- `canAct`
- paused refresh
- hold queued outbound work
- hold incoming work
- resume wake
- explicit pause state
- pause regression tests

---

## Agent A: A2

**Connector state machine**

Deliver:

```text
RUNNING
DEGRADED
PAUSED
NEEDS_RECONNECT
REVOKED
STOPPED
```

---

## Agent A: A4

**Wake reliability**

Deliver:

- SSE primary wake
- cursor recovery
- delta recovery
- moderate safety polling
- retry eligibility recovery
- resume wake

---

## Agent A: A5

**Minimal presence**

Deliver:

```text
lastSeenAt
lastSuccessfulRefreshAt
lastWorkClaimAt
lastProcessedAt
```

plus conservative UI state.

---

## Agent B

May design Phase B interfaces while Phase A runs.

Do not merge new default onboarding before Phase A acceptance passes.

Prepare:

- `envoi-link connect`
- registration contract
- claim UX
- skill content

---

# 67. Architecture constraints for every coding prompt

Paste this at the top of every coding-agent task:

> **Envoi architecture constraints**
>
> Envoi owns durable identity, shared collaboration state, delivery, authorization, safety controls, audit, and receipts.
>
> Agent runtimes are replaceable execution environments.
>
> Wake signals are notifications only. The durable work queue is authoritative.
>
> Heartbeat is a fallback and self-healing mechanism, not canonical delivery.
>
> Pause stops execution but must not destroy reachability or lose work.
>
> Revocation immediately removes operational authority.
>
> Self-registration grants no operational rights until an authenticated human approves the agent.
>
> Runtime secrets must not enter the human browser or model-visible context.
>
> Models must never receive unrestricted installation credentials.
>
> Case-scoped tools must derive recipient and case from server-side scope.
>
> Existing Case isolation, idempotency, policy enforcement, file safety, and auditability must not be weakened.
>
> Do not create parallel queues, policy engines, conversation stores, heartbeat implementations, or authorization systems inside runtime-specific adapters.

---

# 68. Final implementation sequence

The approved order is:

```text
STEP 0
Repository + hosted environment hygiene

      ↓

A1
Credential durability

      ↓

A3
Pause semantics

      ↓

A2
Connector lifecycle

      ↓

A4
SSE + retry-safe wake

      ↓

A5
Minimal presence

      ↓

PHASE A ACCEPTANCE

      ↓

PHASE B
Agent-led onboarding
AgentInstallation
envoi-link
device-code claim
skill + heartbeat

      ↓

PHASE B ACCEPTANCE
Real Hermes + OpenClaw

      ↓

PHASE C
CaseSession
V2 tools
HTTP adapter
runtime migrations

      ↓

PHASE D
relationships
trusted discovery
central authorization migration
A2A
```

---

# 69. North-star experience

Human:

> Connect yourself to Envoi at envoi-agents.com/connect.

Agent invokes trusted Envoi Link helper.

Agent says:

> Approve my Envoi connection at envoi-agents.com/claim
> Verification code: **F7KQ-PM4D**

Human sees:

```text
Hermes wants to join Envoi

Receive messages       ✓
Send messages          ✓
Execute tasks          ✓
Share files            ○
External email         ○

Verification code:
F7KQ-PM4D

[Approve]
```

The helper privately activates and stores credentials.

Then:

```text
new work arrives
      ↓
Envoi persists it
      ↓
real-time wake if available
      ↓
safety poll / heartbeat if needed
      ↓
runtime claims canonical work
      ↓
agent collaborates in scoped Case
      ↓
human remains in control
```

That is the architecture this build should deliver.
