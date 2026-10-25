---
name: envoi-bouncer
description: Write or debug the Envoi bouncer - server/gateway/checks.ts, gateway.ts (evaluate and act), server/data/northwind.ts, POST /api/act and GET /api/selftest. Use for the five checks, ALLOWED/BLOCKED decisions, receipts, protected data isolation, or the integration self-test.
---

# The bouncer (gateway)

Design borrowed from Envoi's production policy engine (`evaluatePolicy` returning reason codes, `assertExactBinding` re-checking at execution time), cut down to five deterministic checks. **The LLM is never asked whether something is allowed.**

## The five checks (always all five, always this order)

| id | Label | Passes when | Failure detail |
| --- | --- | --- | --- |
| signed | Signed by the client | `recoverSigner(mandate, signature)` equals the Northwind issuer address (case-insensitive) | Not signed by Northwind |
| agent | The right AI | request `agentId === mandate.agentId` | This slip belongs to a different AI |
| valid | Still valid | `mandate.issuedAt <= actionTime && actionTime < mandate.expiresAt` | This slip has expired or is not active yet |
| stamped | Stamped before request | anchor exists, `status === 1`, `from` = issuer, `data` = `digestOf(mandate)`, and `anchor.blockTimestamp <= actionTime` | Stamped on Monad after this request (or "No matching stamp on Monad" when missing or mismatched) |
| scope | `{Action label}` on the slip | `allowedActions.includes(action)` | `{Action label}` is not on this slip |

## Implementation shape

```ts
// server/gateway/checks.ts — pure functions, no data imports
export async function evaluate(slip: Slip, action: string, actionTime: number, agentId: string = AGENT_ID): Promise<Check[]> {
  const m = slip.mandate, label = actionLabel(action);
  let signer = ""; try { signer = recoverSigner(m, slip.signature); } catch {}
  const signed = signer.toLowerCase() === ISSUER.toLowerCase();

  let stampedPass = false, stampedDetail = "No matching stamp on Monad";
  const want = (() => { try { return digestOf(m).toLowerCase(); } catch { return ""; } })(); // bad slip -> no match
  try {
    const a = slip.anchor ? await lookup(slip.anchor.txHash) : null;
    const matches = !!a && want !== "" && a.status === 1 && a.from.toLowerCase() === ISSUER.toLowerCase()
                 && a.data.toLowerCase() === want;
    if (matches) { stampedPass = a!.blockTimestamp <= actionTime; if (!stampedPass) stampedDetail = "Stamped on Monad after this request"; }
  } catch { stampedDetail = "Could not reach Monad to verify the stamp"; }   // FAIL CLOSED

  const checks: Check[] = [
    { id: "signed", label: "Signed by the client", pass: signed, detail: "Not signed by Northwind" },
    { id: "agent", label: "The right AI", pass: agentId === m.agentId, detail: "This slip belongs to a different AI" },
    { id: "valid", label: "Still valid", pass: m.issuedAt <= actionTime && actionTime < m.expiresAt, detail: "This slip has expired or is not active yet" },
    { id: "stamped", label: "Stamped before request", pass: stampedPass, detail: stampedDetail },
    { id: "scope", label: `${label} on the slip`, pass: m.allowedActions.includes(action), detail: `${label} is not on this slip` },
  ];
  return checks.map(c => c.pass ? { ...c, detail: "" } : c);   // typed array first, or tsc widens id to string
}
```

```ts
// server/gateway/gateway.ts — the ONLY importer of server/data
import { DATA } from "../data/northwind";   // { read_regional_margins: fn, read_employee_salaries: fn }
export async function act(req: { agentId: string; mandateId: string; action: string }, source: "agent" | "forced") {
  const slip = state.getSlip(req.mandateId);
  if (!slip) throw httpError(404, "No permission slip yet. Click Sign and notarize first.");
  const actionTime = await latestTimestamp();               // chain time, not server time
  const checks = await evaluate(slip, req.action, actionTime, req.agentId);   // request agentId, not a constant
  const ok = checks.every(c => c.pass);
  const fn = DATA[req.action as keyof typeof DATA];
  const data = ok && fn ? fn() : null;                       // data only on a full pass
  return state.addReceipt({ kind: "action", source, decision: ok ? "ALLOWED" : "BLOCKED",
    actionTime, checks, data, agentId: req.agentId, mandateId: req.mandateId, action: req.action,
    explorerUrl: slip.anchor?.explorerUrl ?? null });
}
```

## Protected data rules

- `server/data/northwind.ts` exports one map, action name → function. No generic `getData(any)`.
- Nothing in `shared/` or `client/` imports it. Grep before every deploy: `grep -rn "northwind" client shared` must not find salary data.
- Margins and salaries come from the team's Demo data tab (four regions; ten employees).
- A blocked receipt has `data: null`, and the UI shows "Data never left Northwind".

## GET /api/selftest (the team's integration test)

Run in order, time each step, return `{ pass, steps: [{ scene, expected, got, ms }] }`:

1. `reset`, then POST /api/slips logic → expect a slip with an anchor.
2. `act(read_regional_margins, forced)` → expect `ALLOWED` with data.
3. `act(read_employee_salaries, forced)` → expect `BLOCKED`, only `scope` failing, data null.
4. dispute logic → expect `REJECTED`, only `stamped` failing.

Run it after every deploy and before every rehearsal. Gate 3 = passes twice in a row on the demo URL.

## Edge tests worth 10 minutes

- Expired slip (set `expiresAt` in the past) → only `valid` fails.
- Wrong `agentId` → only `agent` fails.
- Tampered mandate (edit `allowedActions` after signing) → `signed` fails and `stamped` fails ("No matching stamp").
- RPC unreachable (bad URL) → `stamped` fails with "Could not reach Monad…", decision BLOCKED. Never ALLOWED on error.
