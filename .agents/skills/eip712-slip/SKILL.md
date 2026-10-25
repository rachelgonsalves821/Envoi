---
name: eip712-slip
description: Write or debug server/chain/slip.ts and POST /api/slips and /api/dispute - building the Envoi permission slip (Mandate), EIP-712 signing, digest, signer recovery, and the backdated amended slip for the dispute scene. Use for any signature, digest, recover, "signed" check failure or dispute work.
---

# Permission slip (EIP-712) and the dispute

The slip is EIP-712 typed data signed by the issuer wallet (Northwind). The **digest** (typed-data hash) is what goes on Monad. Recovering the signer proves who approved; the Monad stamp proves when.

## Exact typed data (field order matters, do not change)

```ts
import { Wallet, TypedDataEncoder, verifyTypedData, hexlify, randomBytes } from "ethers";

export const DOMAIN = { name: "Envoi", version: "1", chainId: 10143 } as const;
export const TYPES = {
  Mandate: [
    { name: "mandateId", type: "string" },
    { name: "issuer", type: "address" },
    { name: "agentId", type: "string" },
    { name: "resource", type: "string" },
    { name: "scenarioId", type: "string" },
    { name: "allowedActions", type: "string[]" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "string" },
  ],
};
// Do NOT add EIP712Domain to TYPES (ethers throws "ambiguous primary type").

const wallet = () => {
  if (!process.env.ISSUER_PRIVATE_KEY) throw new Error("ISSUER_PRIVATE_KEY is not set");
  return new Wallet(process.env.ISSUER_PRIVATE_KEY);
};
export const issuerAddress = () => wallet().address;

export function buildMandate(input: { scenarioId: string; allowedActions: string[]; mandateId?: string; issuedAt?: number }) {
  // 60 s grace: actionTime is CHAIN time; if the server clock runs ahead, a fresh slip would fail "valid".
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000) - 60;
  return {
    mandateId: input.mandateId ?? "northwind-atlas-001",
    issuer: issuerAddress(),
    agentId: "atlas-research-agent",
    resource: "northwind-data-api",
    scenarioId: input.scenarioId,
    allowedActions: [...input.allowedActions].sort(),   // canonical order: order changes the digest
    issuedAt,
    expiresAt: issuedAt + 5 * 24 * 3600,
    nonce: hexlify(randomBytes(4)).slice(2),             // 8 hex chars
  };
}

export async function signMandate(m: ReturnType<typeof buildMandate>) {
  assertExactKeys(m);
  const signature = await wallet().signTypedData(DOMAIN, TYPES, m);
  const digest = TypedDataEncoder.hash(DOMAIN, TYPES, m);
  return { signature, digest };
}

export const recoverSigner = (m: object, signature: string) => { assertExactKeys(m); return verifyTypedData(DOMAIN, TYPES, m as any, signature); };
export const digestOf = (m: object) => { assertExactKeys(m); return TypedDataEncoder.hash(DOMAIN, TYPES, m as any); };

function assertExactKeys(m: object) {
  const want = TYPES.Mandate.map((f) => f.name).sort().join(",");
  const got = Object.keys(m).sort().join(",");
  if (want !== got) throw new Error(`Mandate fields do not match the signed type: ${got}`);
}
```

## Pitfalls that fail silently

- **Extra JSON fields are not signed.** ethers ignores keys not in `TYPES`. `assertExactKeys` prevents shipping an unsigned field.
- **Wrong domain chainId** recovers a different address with no error, so the `signed` check fails "mysteriously". Domain must be exactly `{name:"Envoi", version:"1", chainId:10143}` everywhere.
- **Never hash `JSON.stringify(m)`.** The on-chain value is `TypedDataEncoder.hash(DOMAIN, TYPES, m)`. The bouncer recomputes the digest from the mandate and compares it with the anchor's `data` (case-insensitive hex compare).
- **Integers.** `issuedAt` / `expiresAt` must be integer seconds. A float throws; milliseconds silently produce a different, wrong slip.
- **Address case.** Compare addresses with `a.toLowerCase() === b.toLowerCase()` (or `getAddress`).

## POST /api/slips

1. `buildMandate({ scenarioId, allowedActions: [scenario.allowed.name] })`
2. `signMandate` → `{ signature, digest }`
3. `ledger.anchor(digest)` → anchor
4. Store `{ mandate, signature, digest, label: "Original", anchor }` in state and return it.

## POST /api/dispute (scene 3)

1. Find the newest receipt with `decision === "BLOCKED"`. If none: `409 {error:"Run the hidden note scene first."}`.
2. Build the amended mandate: same as the original slip, but `mandateId: "northwind-atlas-001-amended"`, `allowedActions` adds the blocked action (sorted), `issuedAt` = **Monday 9:00 AM this week, New York time**, fresh nonce, and **keep the original `expiresAt`** so the `valid` check passes.
3. Sign with the real issuer key (signature is genuine). **Before anchoring, wait until chain time has moved past the action**, otherwise the stamp can land in the same second and every check passes (always on the mock, intermittently on Monad, which makes the selftest flaky):
   `while ((await ledger.latestTimestamp()) <= blocked.actionTime) await new Promise(r => setTimeout(r, 400));`
   Then anchor it.
4. `gateway.evaluate(amendedSlip, blocked.action, blocked.actionTime, blocked.agentId)`. Never fetch data here.
5. Expected checks: signed ✓, agent ✓, valid ✓, **stamped ✗** (anchored after the action), scope ✓. Save the receipt with `kind:"dispute"`, `source:"forced"`, `decision: checks.every(c => c.pass) ? "ALLOWED" : "REJECTED"`, `data: null`, `actionTime: blocked.actionTime`, and `explorerUrl: amendedSlip.anchor.explorerUrl` (the amended stamp, which is the one the timeline shows landing late).

Monday 9:00 New York in unix seconds (Replit servers run in UTC):

```ts
export function mondayNineNY(nowSec = Math.floor(Date.now() / 1000)): number {
  const tz = "America/New_York";
  const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(ms).map(p => [p.type, p.value]));
  const p = parts(nowSec * 1000);
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day - dow, 9, 0, 0);      // Monday 09:00 "as if UTC"
  let t = guess;
  for (let i = 0; i < 2; i++) { const q = parts(t); t = guess - (Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second) - t); }
  const sec = Math.floor(t / 1000);
  return sec <= nowSec ? sec : sec - 7 * 86400;                              // never in the future
}
// Verified: Sat Oct 24 2026 -> 1792414800 (Mon Oct 19 2026 09:00 EDT); handles Monday-before-9am and DST weeks.
```

## Story guardrail (for the voiceover, not code)

The amended slip carries a genuine Northwind signature. Narrate it as "after the leak, someone at the client signs a slip dated Monday to make the problem go away. The signature is real. The date isn't." Do not narrate it as a slip "the client never signed".

## Acceptance check

- sign → recover returns `issuerAddress()`.
- Changing any one field changes `digestOf`.
- Dispute returns `REJECTED` with only `stamped` failing.
