# Offline dedicated-runtime model admission

This implements the host-side request/binding/checkpoint portion of the revision 1
design in PR #133. It is not wired into Hermes, OpenClaw, an HTTP listener or a
download entrypoint. Existing `SCOPED_PROVIDER_ISOLATION_UNAVAILABLE` refusals
remain unchanged. Synthetic tests never execute a vendor runtime or model.

## What the component does

- Captures an immutable agent, installation, work, case, fence, generation,
  provider build, policy digest, exact model, fixed HTTPS Responses endpoint,
  canonical allowed-tool subset and expiry of at most 15 minutes.
- Builds the expected stateless, non-streaming request from the existing private
  work journal and canonical tool schemas. Host metadata and the random capability
  are not added to model input. The host must already have fetched the canonical
  snapshot and populated the journal with the approved case-local history.
- Compares the entire decoded request, not just tool names. Object-key order is
  irrelevant; extra fields, different history, tool order/schema changes, native
  tools and provider references are refused. It forwards its captured canonical
  body, never caller-supplied headers, URLs or partially filtered input.
- Rejects duplicate JSON keys (including escaped aliases), malformed UTF-8,
  non-finite JSON numbers, excess depth/nodes and bodies over 256 KiB. Only the
  bounded text/function-call/function-output history format is supported initially.
  Reasoning references, remote images/files, provider persistence, background
  execution and streaming need separate reviewed serializers; none silently falls
  back or gets stripped from a request.
- Uses unpredictable per-request capabilities, bounded outstanding tickets and
  single-flight identical submissions. Capabilities stay in host transport state,
  not prompts or persistent metadata. The caller must protect the actual transport
  and redact capabilities; this module does not implement an authenticated listener.

## Existing journal, not a second supervisor or queue

`ScopedRunRecord.admission` is an optional backward-compatible checkpoint in the
existing `ScopedRunStore`. It contains only identifiers, request/binding digests,
fence, bounded request-ID history and state. It adds no second journal directory.

1. `prepare` durably records the expected request before issuing a capability.
2. `submit` revalidates host authority under the work journal's exclusion and
   durably records `started` before calling the fixed host transport.
3. After receiving a complete bounded response, authority is checked again. The
   trusted `consumeResponse` callback must apply the existing response decoder and
   record model output/pending typed tool calls in the returned journal record.
4. The returned record and `completed` admission checkpoint are saved before the
   response is reported successful. This means response handling was journaled,
   not that any tool or the canonical case completed.

A response lost after `started`, malformed response, decoder failure or uncertain
save refuses new model sampling with `MODEL_OUTCOME_UNCERTAIN`. The host must
reconcile its journal/canonical effects; this component neither invents a result
nor automatically issues another request. Every used request ID remains reserved
within the bounded 16-request run. A prepared but unstarted request can be
reissued after recovery with identical history and a newer lease fence; the old
capability cannot submit through the changed durable binding. A different request
or context at that checkpoint is a conflict, not permission to abandon work.
The older Responses work loop refuses any admission-owned journal rather than
re-sampling it through an unguarded compatibility path.

`FileScopedRunStore` exclusion is process-local, including its real-path alias
handling. It is NOT a cross-process lock. The accepted future host must enforce
one owning connector process and actual termination/containment of old execution
trees. No concurrent multi-process safety or platform enforcement is claimed.

## Cancellation and limits

Generation retirement is synchronous. Before a forwarding callback is invoked,
its abort controller is registered without an intervening await. Cancellation
aborts every captured request and refuses queued/late admission. A noncooperating
forwarding promise is raced with cancellation, so a late response cannot update
the journal or report success through that request. Local expiry also retires the
binding without polling. State is rechecked after asynchronous authority/storage
steps; authority is refreshed again after obtaining serialized journal access.
Authority waits have a 10-second deadline and are interrupted by retirement;
an unresponsive authority callback cannot permanently retain the work lock.
Cached response access rechecks authority too. Journal context is compared again
under the submission lock, and cancellation is checked after lock cleanup before
public success. Response bytes are copied before any subsequent await so the
returned body cannot differ from the response that was durably consumed.

Cancellation cannot retract bytes already delivered upstream or undo a completed
server effect. A journal write already in progress can finish, but cancellation
still prevents reporting local success. Current server CaseSession/fence checks
remain the final authorization boundary for tool effects. The trusted transport
must implement its own bounded timeout, full response buffering, redirect/status/
encoding checks and upstream credential custody. The admission module accepts this
as a trusted-host callback; the component below supplies its bounded transport
implementation, still tested with synthetic fetch only. Unexpected transport/
decoder failures have sanitized errors.

`createScopedModelTransport` supplies the next offline-tested forwarding component:
one captured HTTPS `/v1/responses` destination, host-held bearer credential, explicit
host-provided fetch implementation, no redirects or automatic retries, bounded
deadline and full JSON buffering. It rejects non-200, foreign/redirected responses,
unsupported content encoding/type, contradictory lengths and oversized or invalid
JSON. It requests identity encoding and bounds the number of stream reads, including
empty chunks. Monotonic elapsed-time checks prevent a microtask-only stream from
starving the deadline. Response ownership is retained even when cancellation falls
between fetch resolution and continuation. Cancellation interrupts even
noncooperating fetch/read promises. Tests compose
it with the actual admission module using fake fetch only. It opens no listener,
reads no credential store and makes no request until explicitly invoked. The host
must separately select/approve the actual provider route and supply the credential;
there is no implicit ambient-network fallback or real provider proof here.
The transport closure is trusted-host-only and must not be exposed as a child
runtime credential or general proxy. Only admission-approved bodies may reach it;
its transport checks do not replace the gate's canonical authority or tool checks.

## What still prevents runtime acceptance

The host must supply actual canonical authority checks and the existing durable
tool-operation decoder, authenticate ingress, prove native executor removal,
enforce OS process/filesystem/network containment and freeze provider routing.
There is no operator boolean that bypasses these requirements. This component's
successful synthetic forwarding does not grant provider admission.

No platform sandbox, model/auth route, provider process, profile, credential,
deployment, enrollment, message, fault or revocation is configured here. Real
Hermes/OpenClaw/xAI, HTTPS and two-owner acceptance still require the combined
implemented candidate and the separately approved Phase C C01–C24 gate. Muse and
Instinct closed-app wake remain independent provider-specific evidence.

## Offline checks

Run in PowerShell from the repository root:

```powershell
npx vitest run --config integrations/vitest.config.ts integrations/agent-bridges/model-admission.test.ts
npx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --resolveJsonModule --esModuleInterop --types node integrations/agent-bridges/model-admission.ts
npm run typecheck
npm run test:integrations
```

The explicit TypeScript command covers the unwired module without changing root
configuration. Tests cover serialized request tampering, canonical schemas,
capability separation, cancellation races and reopening the actual private file
journal. They do not establish provider or hosted acceptance.
