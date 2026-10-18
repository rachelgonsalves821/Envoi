# Phase C typed case client

Task branch: `lane-b/C-B2-case-tools`, isolated worktree `Envoi-phase-c-case-tools`. The exact approved publication is PR #116 at `15fff09f336fe941858287511471b07b9f5184f8`, including all nine case tools and the CaseSession amendment. Rachel approved that exact completed contract in Codex after the consuming review passed. Integration remains Je's responsibility. The branch carries unchanged C-B1 commit `5c7e336` as dependency commit `20c1132`; it does not change PR #118.

## Implemented locally

- `CaseToolsClient` is a trusted-host, Node 22+ SDK client over an existing private `CaseSessionChannel`. It exposes typed snapshot, reply, proposal, decision, authority, human-request, asset-list/share and completion methods. No installation token, lease, REST writer or alternate transport enters the model boundary.
- Each client takes a canonical first-page snapshot before any action. Concurrent calls are serialized within that client; clients for separate cases and owners do not share snapshot initialization, request ids or cancellation state. The server remains authoritative for cross-case authorization and current allowed actions.
- Callers supply explicit stable idempotency keys. Arguments are validated and copied before asynchronous work; retries must reuse those same logical keys. Snapshot hints do not block a canonical replay after a prior write changed case state. No automatic new key, authority fallback or privileged route exists.
- Inputs and results use a derived schema closure from the exact approved publication. A deterministic test compares it with the canonical source. The artifact contains model tool schemas, not fixture responses or host credentials. Ajv compilation stays in the trusted host; owner browser code must not import this module or receive session tokens.
- Responses require matching JSON-RPC id/tool, a single bounded JSON text result, closed result shapes, correct owner/counterparty and coherent error retryability. Snapshot results are deeply frozen. Generic error messages do not echo remote diagnostics.
- First-page snapshots must include the current work; older pages must omit it. Serialized UTF-8 limits include JSON escaping for requested text, events, options and asset metadata. Authority results must match the requested action and proposal/option. Asset reads must match the requested reference and list/single mode, not just a valid checksum.
- Inline file content must be clean permitted text, within 32 KiB, and match the metadata size and SHA-256. Binary/large files stay host operations. Completion returns a canonical receipt; it never settles a work lease.
- A successful human request makes the client refuse further calls in that turn. Runtime adapters must stop the model, return to the existing host work loop, and later handle fresh `human_decision` work. They must not wait inside the old turn.
- The connector validates the full new human-decision envelope before admission, binds the other agent as session counterparty, handles approve/decline/expiry, and keeps human/request/evaluation ids out of the model projection. Legacy prompt/write paths explicitly refuse the new kind rather than treating a human as an agent.

## What this does not complete

The new SDK is not yet connected to real Hermes, OpenClaw or xAI/Grok tool turns. Those C-B3 adapter migrations, owner decision/asset/outcome projections for C-B3/C-B4, final combined CI/artifact validation and hosted C-B6 evidence remain separate work. Current helper/connector runtime entry points retain their existing legacy behavior; a rebuilt download alone does not advertise the new SDK as an adopted runtime feature.

HTTPS wake requires its separately published, reviewed and approved contract. No Muse/Instinct callback support or closed-app wake is inferred from this client. No server implementation, merge, deployment, feature flag, enrollment, runtime change, live send/fault or revocation is authorized by the contract implementation approval.

## Validation

The local client tests consume the canonical publication directly: host decision claim/mint, all nine tool shapes, idempotent results, authority refusal, clean text checksum, asset/tenant denial, closed cases and separate case/owner contexts. All requests use mocked fetch; the canonical fixture suite checks contract examples, not a running server implementation.

PowerShell commands:

```powershell
npm run test:sdk:typescript
npm run test:integrations
npm run test:frontend
npm run typecheck
npm run build
git diff --check
```

Record actual final results in the task PR; no GitHub CI or hosted pass is claimed by this local implementation note. Preserve original paused case `case_0260691b187444b08368d1047ee317cb`, Je's live gate, concurrent distribution/launcher work and the separate uncommitted preparation/review files.

### Local validation checkpoint, 2026-10-17

- TypeScript SDK: 523 passed, including 95 focused typed-client tests and 149 consuming contract checks.
- Integrations: 260 passed / 1 existing skip; frontend: 350 passed; Python SDK: 6 passed.
- Full backend rerun: 536 passed / 19 existing skips; generated-download checks: 4 passed.
- Typecheck, build and whitespace checks passed. Canonical contracts and all server/database/worker/scanner paths remain unchanged against approved publication `15fff09`.
- Independent client review identified asset/authority response-binding, paging, metadata byte-limit and exported-type gaps; all were addressed with regressions. Final review and any later exact-head CI must be recorded separately.

### Existing backend test-clock defect

The initial full backend run failed `test/agent-registration-cleanup.test.js`'s second-registration expected-null assertion. The test advances cleanup to the first registration's creation time plus 24 hours and 60 seconds, then creates a second registration at the unchanged real clock. During the final minute of an hour, the cleanup cursor has already advanced past that second record's hour bucket. This is an inconsistent test timeline, not evidence of a production failure with normally advancing time.

Read-only frozen-Date reproduction against unchanged source: creation at `21:58:59.999Z` passes all five tests; `21:59:00Z` and `21:59:50Z` reproduce the one assertion failure; `22:00:00Z` passes. Advancing creation time consistently also passes at `21:59:50Z`. No test was weakened or skipped. The full rerun passes, but the known test flake remains unfixed in this client branch.

[Lane A handoff](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6241963646) requests separate stores for the two scenarios or a consistent shared clock, retaining assertions and adding hour-boundary coverage. Lane B does not edit the server or its test. Genuine backwards-clock resilience is a separate production consideration.
