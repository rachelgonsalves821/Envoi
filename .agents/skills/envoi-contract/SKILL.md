---
name: envoi-contract
description: Project rules for the Envoi hackathon app - shared JSON contract, endpoints, file ownership, folder layout and on-screen vocabulary. Use for ANY change in this repo before writing code, and whenever a type, route, file location or UI wording is involved.
---

# Envoi shared contract and project rules

Envoi lets one company's AI agent work inside another company's data with proof. The data owner (Northwind) signs a permission slip, Envoi stamps the slip's fingerprint on Monad testnet, and a bouncer checks every agent request against the slip before any data moves. Every decision lands on a public record.

The source of truth is `ENVOI_BUILD_SPEC.md` (sections 3 and 7). This skill is the short version. If they disagree, the spec wins; tell the user about the conflict.

## Non-negotiable rules

1. The LLM never decides access. The agent only proposes tool calls; deterministic code in `server/gateway` decides.
2. Protected data lives only under `server/data/`. Nothing in `shared/` or `client/` may contain salaries or margins. Only `server/gateway/gateway.ts` imports `server/data/northwind.ts`.
3. One Express process, in-memory state in `server/state.ts`. **No database, no auth, no smart contract, no websockets.** Do not wire in Replit's built-in Postgres even though it exists.
4. Every chain claim is a real Monad testnet transaction. `MOCK_CHAIN=1` is only for parallel building before Gate 2.
5. Never do network calls (RPC or LLM) at server boot. Server listens on `0.0.0.0` and `process.env.PORT`; Express serves the built Vite client.
6. Errors are always `{ "error": "plain sentence" }` with a 4xx/5xx status.

## File ownership (do not edit files you do not own)

| Owner | Files |
| --- | --- |
| P1 Chain | `server/chain/slip.ts`, `server/chain/ledger.ts`, `server/chain/mockLedger.ts`, `server/routes/slips.ts` |
| P2 Bouncer + agent | `server/gateway/*`, `server/data/*`, `server/agent/*`, `server/routes/act.ts`, `server/routes/agent.ts`, selftest |
| P3 Product | `client/*`, `shared/scenarios.ts`, `server/state.ts`, `server/routes/state.ts`, scaffold |
| All three together | `shared/contract.ts` (frozen at 9:50) |

When asked to change something outside the requester's files, stop and say whose file it is. Replit Agent prompts run by P3 must not modify `server/chain`, `server/gateway`, `server/data` or `server/agent`.

## Types (`shared/contract.ts`)

```ts
export type Mandate = {
  mandateId: string; issuer: string; agentId: string; resource: string;
  scenarioId: string; allowedActions: string[];
  issuedAt: number; expiresAt: number;   // unix SECONDS
  nonce: string;                          // 8 hex chars
};
export type Anchor = { txHash: string; blockNumber: number; blockTimestamp: number; explorerUrl: string };
export type Slip = { mandate: Mandate; signature: string; digest: string; label: "Original" | "Amended"; anchor: Anchor | null };
export type CheckId = "signed" | "agent" | "valid" | "stamped" | "scope";
export type Check = { id: CheckId; label: string; pass: boolean; detail: string };
export type Decision = "ALLOWED" | "BLOCKED" | "REJECTED";
export type Receipt = {
  id: string; kind: "action" | "dispute"; createdAt: string; actionTime: number;
  agentId: string; mandateId: string; action: string;
  source: "agent" | "forced"; decision: Decision; checks: Check[];
  data: unknown | null; explorerUrl: string | null;
};
```

Checks are always returned as all five, in the order signed, agent, valid, stamped, scope.

## Endpoints

| Method + path | Body | Returns | Owner |
| --- | --- | --- | --- |
| POST /api/slips | `{scenarioId}` | Slip | P1 |
| POST /api/dispute | none | Receipt (kind "dispute") | P1 |
| POST /api/act | `{agentId, mandateId, action}` | Receipt (source "forced") | P2 |
| POST /api/agent/run | `{reportId: "clean"|"poisoned"}` | `{transcript, proposedCalls, receipts}` | P2 |
| GET /api/agent/eval | `?n=10&reportId=poisoned` | `{n, salariesProposed, rate}` | P2 |
| GET /api/selftest | none | `{pass, steps:[{scene, expected, got, ms}]}` | P2 |
| GET /api/state | none | `{scenario, slips, receipts (newest first), counter}` | P3 |
| POST /api/reset | none | `{ok:true}` | P3 |
| GET /api/health | none | `{ok, mockChain, issuer, rpc}` | P3 |

Constants: agentId `atlas-research-agent`, mandateId `northwind-atlas-001` (amended: `northwind-atlas-001-amended`), resource `northwind-data-api`, actions `read_regional_margins` (allowed) and `read_employee_salaries` (forbidden).

## Words on screen

Use: permission slip, bouncer, notary stamp, public record, Allowed, Blocked, Rejected, "Data never left Northwind".
Never show: mandate, gateway, digest, hash, EIP-712, nonce. Truncate addresses and tx hashes as `0x3f9a…c21e`.

## Before you finish any change

- Does it keep the contract shapes exactly? If not, stop and flag it.
- Did you touch a file you do not own? Revert that part.
- Did you add a dependency on a database or a boot-time network call? Remove it.
