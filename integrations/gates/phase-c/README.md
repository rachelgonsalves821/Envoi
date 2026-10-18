# Phase C client preparation (C-B0)

Publication baseline: integration `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`. This separate preparation branch preserves PR #114's published history and carries its client-owned source inventory and tests alongside the reviewed evidence preparation.

This directory prepares Rachel/Codex's client work from the [Phase C execution plan](../../../docs/architecture/agent-native-v2/phase-c-execution-plan.md). It neither implements unpublished server protocols nor enables a route. Je retains server contracts, fixtures, root/release wiring and integration. Existing CSP-fix and distribution workstreams retain their claimed files.

## Current dependency result

The canonical contract ids are `case-session`, `case-tools` and `http-wake`, each version 1. The inventory uses those actual ids, not the earlier planning suffixes. PR #116 at `15fff09f336fe941858287511471b07b9f5184f8` completes all nine case tools and amends CaseSession; Rachel approved that exact client contract. PR #121 at `269d9697cb8dd2d6ddd77f49e671c7fff69164ca` publishes HTTPS wake with 140 executable fixtures. These publications are present in this branch's integration baseline. Wake implementation still requires its exact-version human approval; published metadata, consuming tests and green CI do not establish deployed behavior or Muse/Instinct support.

C-B0's source inventory and evidence preparation can proceed. Independent consuming ACKs for these publications are recorded separately; this inventory does not recreate or certify them. C-B1 through C-B5 implementation requires the appropriate approved contract and published fixtures; C-B6 additionally requires Je's combined candidate and the real hosted/runtime gates. A planning merge does not approve wire schemas.

## Read-only source check

From the repository root in PowerShell:

```powershell
node integrations/gates/phase-c/source-readiness.mjs
npx vitest run --config integrations/vitest.config.ts integrations/gates/phase-c/source-readiness.test.ts
```

The source check reads only the canonical registry and the listed source files. It makes no network requests, starts no runtime, reads no profile/session credentials and writes no files. It emits source SHA-256 hashes rather than source contents. Exit 2 means dependencies are missing/invalid; exit 0 means a contract review is required, never that implementation or hosted acceptance passed. It does not validate fixture contents, prove approval or check server behavior.

## Verified impact inventory

| Client seam | Current source | Phase C work after contract approval |
| --- | --- | --- |
| Host work lifecycle | `sdk/typescript/src/connector.ts`, `lifecycle.ts` | Reuse host claim/renew/ack/settlement, durable rotation, cancellation and retry; consume session scope without moving lease control into the model (C-B1). |
| Typed API and assets | `sdk/typescript/src/index.ts`, `sdk/python/envoi_protocol/__init__.py` | Add only the approved scoped-tool API types and response validation where the contract requires client support; retain existing native identity/asset compatibility (C-B2/C-B4). |
| Runtime adapter boundary | `integrations/connector/adapter.ts` | Preserve discovery, preflight, private configure, bridge verification and sanitized describe; no second enrollment engine (C-B1/C-B3). |
| Local MCP relay | `integrations/agent-bridges/mcp-relay.ts` | Bind tool access to the current work/case scope, enforce approved tool subset, cancel stale turns and prevent privileged fallback (C-B2/C-B3). |
| Shared model bridge | `integrations/agent-bridges/bridge.ts`, `providers.ts` | Replace stitched prompts/parsed output with approved snapshot/tool execution while retaining host lifecycle and idempotency (C-B2). |
| Hermes | `integrations/hermes/runtime.ts`, `adapter.ts`, `turn.ts`, `lease-write.ts` | Preserve relay and real tool invocation readiness; migrate scoped model access without duplicating Gateway setup (C-B3). |
| OpenClaw | `integrations/openclaw/runtime.ts`, `adapter.ts`, `turn.ts`, `mcp-relay.ts` | Snapshot-first tool calls, bounded legacy compatibility, parallel-case isolation and cancellation (C-B3). |
| xAI/Grok | `integrations/grok/runtime.ts`, `adapter.ts` | Scope provider tools without exposing installation refresh credentials; record actual xAI runtime tested (C-B3). |
| Owner UI | `frontend/src/api.ts`, `App.tsx`, `model.ts`, `conversation-timeline.ts` | Render canonical decision, asset and completion results, preserve owner attribution and CSRF handling (C-B3/C-B4/C-B6). Do not overlap the separately claimed onboarding CSP fix. |
| Generic HTTPS receiver | New client module after `http-wake` contract approval | Verify opaque callback and fetch canonical work through the approved private client boundary; Je owns endpoint/signature/SSRF server enforcement (C-B5). |

Do not change shared source files while another Phase B task owns them. New Phase C modules can be assigned after publication; move each migration onto the integrated fix rather than branching a second copy of the old adapter. Source hashes in the report identify the reviewed inputs; they are not a hosted artifact match.

## Published contract checkpoint

The session/tools publication at `15fff09f336fe941858287511471b07b9f5184f8` has passed the independent consuming review and received explicit human implementation approval. The `http-wake` v1 publication at `269d9697cb8dd2d6ddd77f49e671c7fff69164ca` has passed its consuming review; its separate exact-version human implementation approval is still outstanding at this checkpoint. Publication and fixture ACK are not implementation, integration or hosted acceptance.

Keep consuming the canonical fixtures rather than copying or weakening them. Je still supplies the combined implemented candidate and server evidence; client code and green task PRs cannot substitute for either. The [evidence worksheet](EVIDENCE.md) lists the future live proofs; no rows are pre-marked passed.

## Offline evidence preparation

The manifest format is a client-owned evidence index, **not** a proposed server API or a replacement for Je's canonical fixtures. Generate a blank single-host worksheet in PowerShell:

```powershell
node integrations/gates/phase-c/evidence.mjs --template
node integrations/gates/phase-c/evidence.mjs C:\private-evidence\phase-c-hermes.json
npx vitest run --config integrations/vitest.config.ts integrations/gates/phase-c/evidence.test.ts
```

The template writes JSON only to standard output; it contains 24 `not_run` rows and no inferred candidate, approval, artifacts or results. Save the index and redacted observation files in your private evidence directory, not in a runtime's credential folder. Maintain separate manifests for each actual host/version/route. `artifactHashes` pins the connector and helper SHA256; the candidate uses a full 40-character commit SHA. Every passing observation must name that same candidate, have a canonical millisecond UTC timestamp, use `hosted` evidence, describe its expected and actual outcomes (each at most 2,000 characters) and link to supporting observations. Record model invocation and canonical effect counts separately; C13–C15 require both counts. Other rows may leave both counts null, but never provide only one. No count value is invented or required to equal one when the actual scenario differs.

Contract/ACK/approval references, accepted Phase B route evidence and live-operation approval references remain necessary. Reference paths are relative to the manifest directory: no URLs, query strings, absolute paths or traversal. Each list permits up to 128 references, each path at most 240 characters, and the complete index at most 512 unique proof files. Referenced files must be nonempty regular files of at most 10 MiB and resolve inside that evidence directory. Symlinked files and directory junctions escaping the root are rejected. Use redacted index files to organize larger private evidence rather than embedding private raw output in this manifest.

This first template targets the helper-based Hermes/OpenClaw gate. A route without those artifacts needs an explicit template review after its route contract is approved, not fabricated helper hashes or automatic acceptance.

The offline inspector reads at most 1 MiB of manifest JSON and checks referenced file paths/types/sizes. It does **not read or print proof contents**, contact a network, inspect provider profiles or change running processes. `referencesChecked: true` means only that the named local files passed those structural checks. The pure `validateEvidence()` function checks metadata only and does not inspect files. Exit 2 means the offline index is incomplete/invalid. Exit 0 and `reviewReady: true` mean **the index and file references are ready for human review only**, not that proof contents are genuine, hashes match real binaries, a runtime passed, approvals are valid, or the gate is accepted. Automated/diagnostic results and waived/failing/missing rows cannot satisfy hosted metadata readiness. The tool does not compare candidates across host manifests, verify freshness or perform a secret scan of arbitrary string values. Do not place raw snapshots, tokens, messages or signed URLs in the index. Unknown fields are rejected; diagnostics never echo input values or file paths.

The [beta coverage audit](BETA-COVERAGE.md) separates existing automated protections from the real-browser/server/host evidence still required. Neither this tooling nor passing client tests closes C-B6.
