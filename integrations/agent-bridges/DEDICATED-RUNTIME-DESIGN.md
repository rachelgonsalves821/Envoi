# Phase C dedicated runtime design — revision 1

Status: offline proposal for review, not an implemented or accepted runtime route.
Prepared 2026-10-18 after Rachel selected “Prepare dedicated-runtime design”.
Repository baseline: `integration/agent-native` at
`c334db199f44f0ce1a3d83d2fef078a3d99ff37c`.

## Decision in plain language

Run Envoi collaboration in a separate, tightly restricted Hermes or OpenClaw
execution process, not in the Gateway serving someone's normal chat. Give each
active case its own execution slot. The existing trusted connector retains the
agent identity, credentials, leases and approval enforcement.

The recommendation is to prove OpenClaw's dedicated route first, then Hermes's,
without dropping either from the Phase C objective. Both have useful supported
building blocks, but neither has been proved to satisfy this design. A private
profile or a new process alone is insufficient. If supported settings cannot
remove an unwanted executable tool, that route remains unavailable; we request
an upstream capability rather than patching the vendor or weakening the gate.

The proposed additional protection is a host-owned model-request admission gate:
inspect the actual serialized inference request before sending it to the model
provider. This closes a different gap from filtering executed tools. It cannot
replace executor isolation, process containment or server authorization.

Rachel's approval covers preparing this document only. Implementation of this
new isolation architecture, vendor execution, platform sandbox changes, model
credentials, profile creation, installation, enrollment, deployment, live sends,
faults and revocation are not authorized by that choice.

## 1. Existing boundaries remain authoritative

- Consume the already approved CaseSession/case-tools publication at
  `15fff09f336fe941858287511471b07b9f5184f8` and HTTP-wake v1 at
  `269d9697cb8dd2d6ddd77f49e671c7fff69164ca`. No new Envoi server wire contract
  is proposed here; any necessary change must go through Je's contract process.
- Reuse the canonical queue, connector credential rotation, work leases,
  snapshot-first typed tools, durable operation keys and owner controls. No new
  registration engine, provider inbox, application supervisor or OAuth service.
- Reuse PR #127's private Hermes transport, PR #129's admission refusal,
  PR #131's scoped wake driver and PR #132's packaged host APIs where applicable.
  Their local tests and CI are not evidence of this new architecture working.
- Reuse the existing service/control integration through its owning workstream;
  do not create a competing background daemon or modify its claimed files.
- Keep `case_0260691b187444b08368d1047ee317cb` paused. Use separately approved
  disposable identities and fresh cases for future live acceptance.

## 2. What the pinned providers do and do not establish

| Provider | Supported building blocks | Remaining proof |
| --- | --- | --- |
| Hermes `ccc695635094d7615373db267b77f894d978b1a0` | Foreground Gateway under an external supervisor; normal-mode private editor MCP; explicit toolset configuration; frozen session policy; custom model endpoint and transport. | The complete effective executable inventory, including plugins, context-engine/native additions, MCP and Tool Search, must actually contain only the captured case tools. Existing ACP inventory observations do not establish this. |
| OpenClaw `9b707074b5f231f6976456ea7431567893fe7d1c` | Agent deny policy, custom model/provider endpoint, Responses client functions and an explicit built-in runtime. | Ordinary deny-all is only one stage. Exclude post-policy ring-zero/delegation additions and late ToolSearch/CodeMode wrappers; prove configuration and model routing cannot change or escape admission. |

These are source-based feasibility findings at exact commits, not verification of
the versions installed on Rachel's computer or a promise about every release.
The design is not permission to upgrade or replace either installation.

### Hermes source implications

The [session toolset resolver](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_policy.py#L521)
checks requested tools against the effective selection. That does not prove an
exclusive final inventory. The broader
[configuration pipeline](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/hermes_cli/tools_config.py#L578)
must also be covered. The
[editor policy](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_local_editor.py#L9)
does not supply the missing complete-inventory admission check.

Use normal mode if private editor MCP is required; do not reuse the disproved
safe-mode/ignore-user-config workaround. A frozen session must not follow live
profile configuration. Explicit suppression still needs an executable proof
that it removes all non-Envoi tools while preserving the private MCP binding.
Tool Search must be disabled, not treated as an equivalent nine-tool interface.

The [Gateway CLI](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/hermes_cli/subcommands/gateway.py#L64)
offers foreground execution and an external-supervisor mode. Own the actual
execution tree; an ACP viewer is not that tree. Do not use replacement, force,
global stop or daemon-discovery actions against an existing personal Gateway.
The [custom-provider resolver](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/hermes_cli/runtime_provider_custom.py#L142)
offers a possible gate-bound model route. This does not prove compatibility with
the user's Nous Portal subscription; that authentication/provider route needs
its own review. Do not silently substitute an API product or request a new key.

### OpenClaw source implications

The [ordinary tool matcher](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/agents/tool-policy-match.ts#L32)
supports deny-all. An empty allow list is not equivalent. Bundle MCP/LSP tools
also pass through a
[final policy stage](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/agents/embedded-agent-runner/run/attempt-bundle-tools.ts).
However, [agent tool construction](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/agents/agent-tools.ts)
has later execution contexts that must be excluded. A dedicated build/configuration
must have no host-bound ring-zero, delegation or swarm tool injection.

[Client functions are added to the effective tools](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/agents/embedded-agent-runner/run/attempt-client-tools.ts),
not an automatic replacement for Gateway tools.
[Tool choice](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/gateway/openai-tool-choice.ts)
is not a native-executor isolation mechanism. Disable ToolSearch and CodeMode at
all effective global/agent/model/run levels. A default or a single global switch
does not rule out a later override.

Use a dedicated custom provider with a fixed gate `baseUrl`, explicit supported
transport and built-in OpenClaw runtime, one exact model and no fallback routes.
Audit per-model endpoint/runtime overrides and actual model policy, not merely a
displayed models list. Supported
[custom-provider configuration](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/docs/concepts/model-providers/custom-providers.md)
does not imply immutable configuration. Its no-auth option is not supported for
every transport; a Responses route may need a nonempty gate-only capability,
never the real upstream provider key.

## 3. Proposed trusted-host composition

```text
Envoi canonical queue and owner controls
                 |
trusted connector: identity, refresh, leases, CaseSession, journal
                 |
immutable case/turn binding + snapshot + approved typed tools
                 |
one owned vendor execution slot per active case
       |                          |
private scoped tool channel       model-request admission gate
       |                          |
CaseSession-authorized MCP         fixed approved model-provider route
```

The gate is a bounded component of the existing host application, not a general
proxy or another Envoi transport service. It forwards only the reviewed provider
protocol and destination. Unknown protocols, paths, content encodings, native
tool types, redirects and auxiliary requests are refused. A later provider
protocol needs review; it is not accepted because a hostname matches.

### Four independent invariants

1. **Executable tools:** supported provider policy removes all other callable
   tools, including direct/hidden executors and late additions. A forged call to
   an unadvertised native tool must have no privileged effect.
2. **Actual model request:** the gate admits only the current captured model,
   complete tool names and schemas. Reject extra, missing, duplicate or changed
   definitions. Never silently strip extras or rely on a prompt/earlier catalog.
3. **Process containment:** a vendor process and its descendants cannot read
   operational/upstream secrets, change trusted inputs or contact alternate
   model endpoints, other local services or another slot's capabilities.
4. **Canonical authority:** every Envoi effect still passes through the current
   CaseSession/fence/lease and server controls. No host-local observation grants
   an approval or substitutes for current authorization.

All four must hold. A successful gate request alone establishes neither executor
isolation nor containment, and a private directory alone establishes neither.

## 4. Execution slots, identity and configuration

- A slot has a new private vendor home, workspace, config and runtime state; it
  does not copy a personal home, global plugins, MCP servers, cookies or auth
  stores. The Envoi installation identity remains in the existing trusted
  connector. New vendor sessions do not create or re-enroll Envoi agents.
- Bind one active case/turn to one slot. Concurrent cases use different slots;
  there is no shared chat history or mutable “current case” lookup. Do not reuse
  a slot for another case until its execution tree is conclusively stopped and
  its capabilities are invalidated. Prefer a fresh slot rather than resetting
  uncertain provider state.
- Pin the actual provider build and dependency/plugin closure, model protocol,
  exact model, runtime/harness, policy and immutable inputs. A Git SHA printed by
  a wrapper is not evidence of the executing code. Reconfiguration or a changed
  source/artifact hash retires the slot and requires a fresh admission.
- The child receives only allowlisted environment and gate/tool capabilities.
  No inheritance of personal provider keys, refresh credentials, proxy settings
  or global plugin paths. Application flags are policy inputs, not a sandbox.
- Enforce trusted-input immutability and process-tree network/filesystem limits
  through a reviewed platform-specific boundary. Current-account ACLs alone do
  not protect secrets from another process running as that same account.
  Read-only checks before execution do not remove time-of-check/use races.
- Fence ingress as well as egress. Only the authenticated trusted host may use
  the slot's exact session/inference entry points. Refuse administrative policy,
  configuration, model/runtime and unrelated-session mutation; disable channels,
  background jobs and alternate run triggers. Neither a loopback port nor an
  outbound firewall rule establishes this control boundary. If supported controls
  cannot restrict these surfaces, the dedicated route is not ready.
- Windows, Linux and macOS each require their own implementation and evidence.
  No cross-platform support is claimed here. If a supported enforceable boundary
  is unavailable on a host, report that route unavailable rather than falling
  back to the ordinary personal Gateway or calling it on-demand-compatible.

## 5. Atomic inference admission and credential custody

Capture agent, installation, work, case, lease fence, turn generation, provider
build, policy/configuration identity, exact model and a deterministic bounded
tool-schema projection before allocating a model turn. Store only nonsecret
digests in diagnostics; keep any sensitive policy material private.

Give the slot an unpredictable host-only capability for that binding. It is not
an Envoi credential, is not put into prompts/tool arguments/logs, and cannot be
retargeted to a successor. Redact it from vendor request journals and errors.
The host validates capability, source confinement, current authority and the
complete final request on every continuation/retry, then forwards to one fixed
upstream endpoint with host-held credentials. Child-controlled headers or URLs
never select the upstream or its credential.

Compare the received serialized request after provider-side transformations,
not an earlier configuration object. Only reviewed deterministic tool-name and
schema transformations are allowed. Name aliases, schema wrappers and provider
limits need exact fixtures. Reject unknown transformations rather than accepting
lossy matching. Validate returned calls too; this is a second defense, not the
primary pre-execution boundary. Account for streaming, retries, reconnects and
body/response bounds before claiming the protocol supported.

The protocol also needs an explicit whole-request allowlist and a parser that
rejects duplicate JSON keys before admission. Tools/model equality does not
authorize every other payload field. The initial design prefers stateless,
bounded case-local history with provider persistence/background execution off.
Reject server-side conversation/previous-response IDs, reusable prompt/file
references, remote input URLs and provider-managed execution unless a separately
reviewed extension verifies ownership, case, turn generation and expiry against
the private journal. Unknown fields fail closed. A provider that requires an
unimplemented stateful continuation is unavailable, not silently downgraded.
The [Responses serializer](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/packages/ai/src/providers/openai-responses-shared.ts#L195)
can apply a late payload transformation, so inspect the actual received body,
including retry/full-history forms, rather than trusting an earlier allowlist.

Make the local admission decision and in-flight forwarding registration share
one ordering boundary with generation revocation. A queued or body-reading
request must recheck the captured generation immediately before forwarding;
cancellation retires that generation and captures every registered request for
abort. Do not leave a validate-then-register gap. This local ordering cannot be
atomic with remote owner revocation, and abort cannot retract bytes already
delivered upstream. The server's current CaseSession/tool authorization remains
the final authority for effects, including that unavoidable network race.

Every inference path must traverse the same admission: fallback, auxiliary,
context-engine, compaction, retry and refreshed tools. Disable unsupported paths;
do not grant a tool-less auxiliary exception. Constrain direct egress so a child
cannot bypass the gate with inherited auth or another SDK. Provider setup/hooks
must not perform privileged actions before the gate is reached.

No public atomic final-inventory/revision RPC has been established at these pins.
The proposal does not invent one: gate admission covers the outgoing request,
while pinned construction/policy and process containment must separately cover
the actual executor registry and configuration race. If that executor proof
cannot be made, stop even if the gate rejects every attempted request.

Do not persist raw gate prompts, tool results, asset URLs, request/response bodies
or auth headers by default. Operational diagnostics contain bounded nonsecret
identifiers/digests and refusal codes. Keep the recovery journal private and
minimal; define retention, deletion and any exceptional content tracing before
implementation approval. Capability redaction alone is not a privacy policy.

## 6. Turn lifecycle, cancellation and recovery

1. Revalidate canonical eligibility; claim/acknowledge using the existing loop.
   Mint a CaseSession and fetch the bounded snapshot before model execution.
2. Prepare the captured slot and private tool binding; verify its confinement,
   supported executor policy and gate route. No model invocation before this.
3. Admit each model request against that captured binding. Serialize effects via
   typed tools with durable logical-operation keys. Plain text is not a send.
4. On a human-input request, preserve canonical waiting state and end the turn.
   A later decision starts from a new authorized canonical snapshot; do not
   replay a stale grant or restore the previous model's authority.
5. On pause, lease loss, case control, revoke or uncertain safety state, invalidate
   the tool and gate capabilities first, cancel active forwarding and the
   captured provider admission, then await bounded terminal confirmation.
   If necessary, stop only the owned execution tree through existing controls.
   Killing an ACP viewer or closing an HTTP connection is not termination proof.
6. Journal turn identity/generation, tool intent/key/result and uncertain provider
   outcomes privately. After a crash, deny old capabilities before recovering
   work; reconcile canonical effects rather than blindly resampling a model or
   replaying a successful write. Stable keys survive an uncertain response;
   stale fences never gain a new capability.
7. Do not complete work until scoped execution and pending tool operations are
   settled under current authority. Work receipts remain distinct from canonical
   case completion/outcome receipts. A late response cannot report a successful
   local turn after cancellation; no client claim implies server rollback.

## 7. Proof matrix before enabling either route

| Proof | Required result | Evidence stage |
| --- | --- | --- |
| Actual final inventory | Extra/missing/duplicate/changed/native tools or unexpected schema transformation cause zero upstream model requests. | Synthetic host tests, then exact vendor build to a fake provider under separately approved execution. |
| Hidden executor denial | A guessed shell/file/browser/plugin/MCP/delegation call cannot execute, even if not advertised. | Pinned constructor/policy tests plus contained real-provider tests; returned-call filtering alone fails. |
| Routing and mutation | Model/endpoint/runtime override, fallback, tool refresh, config/plugin change and stale capability cannot bypass admission or target a new case. | Deterministic races, then matching-build host evidence. |
| Ingress and context references | Unauthorized admin/session calls, background triggers, duplicate JSON keys and a valid tool list paired with a foreign-case conversation/file/prompt reference cause zero unbound execution or upstream requests. | Whole-request/entry-point fixtures and contained vendor tests. |
| Admission ordering | Cancellation between validation and forwarding revokes queued admission and aborts every registered request; already-delivered bytes are not claimed retracted. | Deterministic race tests plus current server authorization evidence. |
| Host containment | Direct egress, local-service escape, descendant process, personal credential read and trusted-input mutation are denied. | Per-platform enforced-boundary evidence, not environment-variable assertions. |
| Private tool custody | Only the captured CaseSession channel executes typed tools; no operational or upstream secret reaches model input/output. | SDK/transport tests and redacted real-host traces. |
| Concurrent cases | Two cases with the same counterparty and a third owner's case retain separate history, schema and operation keys. | Synthetic concurrency and Phase C C01–C03. |
| Controls and recovery | Cancellation stops owned execution; lost responses/restarts preserve one canonical effect and deny old capabilities/fences. | Fault tests, then approved C13–C18. Count model invocations separately from canonical effects. |
| Collaboration | Propose/counterpropose/accept/reject, human decision, safe asset sharing and canonical outcome work on the actual runtime. | Approved C04–C12 with both owners' evidence. |
| Wake and browser journey | Valid/missed/duplicate wakes recover canonical work; owner isolation, files, approvals and sign-out remain correct. | Approved C19–C24 on one combined candidate. |

An always-refusing gate, mocked callback, green CI, ACK reply, a distinct profile
name or a generic HTTPS receiver is not a provider acceptance result.

## 8. Work division and approval checkpoints

| Next work | Owner | Stop before |
| --- | --- | --- |
| Review this design, choose the first platform and supported model/auth route, resolve gate/privacy/custody choices | Rachel, with independent client security review | Runtime implementation; this preparation choice does not approve the proposed architecture. |
| After approval, implement bounded gate/binding/journal and provider-specific policy proofs in separately claimed Lane B paths | Rachel/Codex | Vendor execution or host configuration without its own authorization; no edits to Je's files. |
| Reuse startup/service/distribution interfaces; request any shared-path change | Existing distribution owner plus Rachel/Codex handoff | Duplicated supervisor or concurrent file editing. |
| Supply C-A2–C-A5 server behavior, integrated exact candidate, flag/rollback plan and server evidence | Je | Claiming contracts/fixtures alone are the implemented candidate. |
| Approve exact candidate deployment, disposable host/profile setup, consent, sends/faults/revoke and countersign | Human release authority | Any live operation not covered by the specific approval. |
| Run matching-artifact real-runtime and two-owner acceptance; report remaining route limitations | Both lanes within their ownership | Declaring full C-B0–C-B6 or beta readiness from local proofs alone. |

First proposed implementation checkpoint: OpenClaw, one explicitly selected
platform and model API route, using only synthetic host tests until vendor/host
execution is separately authorized. Hermes follows with the same four invariant
proofs; if its supported configuration cannot remove all other executors, publish
the precise upstream gap. Do not rename a direct model API wrapper “Hermes”.

No changes to normal Hermes/OpenClaw, no vendor monkey-patches, and no weakening
of `SCOPED_PROVIDER_ISOLATION_UNAVAILABLE` are part of this design preparation.
Muse/Instinct connection and closed-app wake remain separately owned, provider-
specific proofs; neither this proposal nor the reference receiver establishes
them. The entire Phase C objective remains open until all assigned implementation,
combined CI, actual route evidence and human acceptance requirements are met.
