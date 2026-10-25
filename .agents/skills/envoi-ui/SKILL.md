---
name: envoi-ui
description: Build or polish the Envoi one-screen React UI in client/ - permission slip, report with hidden note, bouncer checks and stamps, public record timeline, control bar, brand tokens and copy rules. Use for any frontend, layout, styling, animation or on-screen wording work.
---

# Envoi UI (P3)

Design principles adapted from Anthropic's `frontend-design` skill (one orchestrated motion moment, structure that encodes information, no template chrome), applied to the brand in `ENVOI_BUILD_SPEC.md` section 8. The brief's tokens win over any default.

## Hard rules

- Do not modify `server/chain`, `server/gateway`, `server/data` or `server/agent`.
- Read state only from `GET /api/state`. After every POST, refetch state. No websockets, no polling loops.
- Never show the words mandate, gateway, digest, hash, EIP-712, nonce. Use permission slip, bouncer, notary stamp, public record.
- Errors render as one plain sentence (the server's `error` field) in the bouncer column. Never a stack trace.
- Disable every control while a request is in flight; show "Checking with Monad…" in the bouncer column.
- Respect `prefers-reduced-motion`: show final states immediately.

## Tokens

```css
:root{
  --bg:#17181a; --raised:#1f2023; --line:#2f3035; --ink:#f3f2ee; --muted:#b9b8b3;
  --accent:#6b84f0;                 /* stamps, links, current step */
  --allow:#3ccf9a; --allow-bg:#123228;
  --deny:#ff6b78;  --deny-bg:#3a1a1f;
  --display:"Newsreader", Georgia, serif;          /* wordmark + ALLOWED/BLOCKED/REJECTED only */
  --ui:"Instrument Sans", system-ui, sans-serif;
  --mono:"Geist Mono", ui-monospace, monospace;    /* addresses, block numbers, times */
}
.card{background:var(--raised);border:1px solid var(--line);border-radius:18px}
```

Load Newsreader (300), Instrument Sans (400/600) and Geist Mono from Google Fonts. Build for 1440×900 at 125% zoom: minimum body 16px, stamps ≥ 64px.

## Layout (one screen, reads left to right like a sentence)

| Area | Content |
| --- | --- |
| Header | "Envoi" wordmark; steps 1 Slip · 2 AI at work · 3 Dispute (current step in accent); "N requests checked" counter = receipts.length |
| Left: Permission slip | For: Atlas (consulting firm). Can see: Regional margins ✓. Cannot see: Employee salaries ✗. Valid until (date). Signed by Northwind ✓. Notary stamp on Monad ✓ block #, time. "View public record ↗". Scene 3 adds the Amended card, dated Monday, beside it |
| Middle: Report the AI is reading | Report text; text between `[[HIDDEN]]` markers is rendered with `color: transparent` (still selectable) until "Show hidden text", then a red-bordered box. Below: "The AI asks for" + proposed calls as chips |
| Right: Bouncer | Five check rows tick in with a 120 ms stagger (✓ green / ✗ red, failed row shows its detail). Then the stamp word. Under it: the margins table, or "Data never left Northwind" |
| Bottom: Public record | Horizontal timeline, oldest left. Dots for slip stamps (accent) and receipts (green/red). Each dot links to its explorer URL when present. In scene 3 the amended stamp visibly lands to the right of the blocked request |
| Control bar (bottom right, driver only) | Show hidden text · Sign and notarize · Run with clean report · Run with report with hidden note · Force the request · Replay the dispute · Reset |

## Motion (the only animated moment)

Checks: each row fades/ticks in over 150 ms, 120 ms apart. Stamp: lands in 250 ms, scale 1.04 → 1. Latest Monad block chip: one slow pulse. Nothing else moves.

## Button → endpoint map

| Button | Call |
| --- | --- |
| Sign and notarize | `POST /api/slips {scenarioId}` |
| Run with clean report | `POST /api/agent/run {reportId:"clean"}` |
| Run with report with hidden note | `POST /api/agent/run {reportId:"poisoned"}` |
| Force the request | `POST /api/act {agentId:"atlas-research-agent", mandateId:"northwind-atlas-001", action:"read_employee_salaries"}` |
| Replay the dispute | `POST /api/dispute` |
| Reset | `POST /api/reset` |

When `/api/agent/run` returns two receipts (model called both tools), show both: ALLOWED and BLOCKED side by side is a stronger picture than one.

## Copy

- Stamps: ALLOWED, BLOCKED, REJECTED. Nothing else in the display face.
- Denials name the failed check in plain words: "Salaries is not on this slip."
- Truncate hex as `0x3f9a…c21e`. Times as `10:42:07 AM`.
- No coins, chain logos, neon gradients, glowing brains, "trustless", "revolutionary", "seamless", "secure".

## Stretch (only after Gate 3): scenario picker

A small select above the slip: Consulting ↔ Client, Bank ↔ Corporate (KYC), Acquirer ↔ Target (clean team). It only swaps labels and reports from `shared/scenarios.ts` and sends `scenarioId` to `/api/slips`. Never let it break the consulting path.

## Done means

Every button works on the deployed URL; a stranger at the back of the room can read the stamp word; nothing on screen says hash or mandate.
