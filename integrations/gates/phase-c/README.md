# Phase C client preparation (C-B0)

Source baseline: integration `264c3fc4426f3957145dd80ce5de0c9529a99cbd`, including merged planning PR #110.

This directory prepares Rachel/Codex's client work from the [Phase C execution plan](../../../docs/architecture/agent-native-v2/phase-c-execution-plan.md). It neither implements unpublished server protocols nor enables a route. Je retains server contracts, fixtures, root/release wiring and integration. Existing CSP-fix and distribution workstreams retain their claimed files.

## Current dependency result

At this baseline, the canonical registry has approved Phase A/B contracts only. The proposed `case-session-v1`, `case-tools-v1` and `http-wake-v1` contracts have no entries or Phase C wire fixtures. Their names are planning proposals; Je may publish different IDs and versions. If so, update the inventory requirements in a reviewed client change.

C-B0's source inventory and evidence preparation can proceed. Contract consumption/ACK remains pending actual publication. C-B1 through C-B5 implementation requires the appropriate approved contract and published fixtures; C-B6 additionally requires Je's combined candidate and the real hosted/runtime gates. A planning merge does not approve wire schemas.

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

## Handoff requested from Je

Publish the three Phase C contract groups in `handoffs.md` and canonical fixtures, with exact commit/version, allowed tools, session custody/fence/expiry, cancellation/error mappings, idempotency, route/flag compatibility and rollback. For HTTPS wake include the actual endpoint challenge, signature/replay and subscription lifecycle. The client must not invent these fields or accept a weaker schema to unblock itself.

Once published, C-B0 consumes the canonical fixtures and posts ACK or exact MISMATCH. Human contract approval then unlocks dependent implementation. The [evidence worksheet](EVIDENCE.md) lists the future live proofs; no rows are pre-marked passed.
