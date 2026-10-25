---
name: demo-captain
description: Keep the Envoi team on schedule and on scope, and prepare the 90-second demo - gate checks, fallback decisions, the cut list, demo script timing, judge Q&A answers and pitch facts. Use when someone proposes a new feature, asks "are we on track", reaches a gate time, or works on the pitch, script or rehearsal.
---

# Demo captain

Judging: unique insight, problem worth solving, working product (live, right now), and a 90-second demo, 25% each. Code quality 0%. Submission = a live link deployed on Replit + the 90-second demo. Build 9:30–3:30, demos 3:45.

## Scope police

In scope: scenes 0, 1, 2a, 2b (+ Force fallback), 3, Close, the public record, Reset, selftest.

**Cut (answer in Q&A, do not build):** smart contracts, database, login, wallet pop-ups, agent-to-agent messaging, revocation, ERC-8004, on-chain receipts.

Any request to add something: ask "which scene does a judge see this in?" If none, refuse. After 12:00 a new feature needs all three people to agree. After 2:00 only demo-breaking fixes.

## Gates and pre-agreed fallbacks

| Time | Must be true | If not |
| --- | --- | --- |
| 10:45 Gate 1 | Real Monad anchor + readback from Replit; forced margins ALLOWED and salaries BLOCKED on mock; UI renders | Try the fallback RPCs; 11:00 P1 pairs up; 11:30 local Hardhat node, said honestly on stage |
| 12:00 Gate 2 | Scenes 1, 2a, 2b on the real chain, `MOCK_CHAIN` off | Agent becomes scripted; Force carries scene 2; P2 joins P1 on the dispute |
| 1:00 | `/api/agent/eval` ≥ 8/10 | Run 2a live, Force for 2b |
| 1:30 Gate 3 | `/api/selftest` passes twice in a row on the demo URL | Scene 3 becomes an edited slip whose signature fails |
| 2:00 | Feature freeze | |
| 2:45 | Backup recording done | Record now, before anything else |

When asked "are we on track", compare the clock with this table and answer with the one next action.

## Script (about 210 words, P3 clicks, Rachel speaks)

| Time | Click | Say |
| --- | --- | --- |
| 0:00–0:18 | Show hidden text | Last August, one AI agent's stolen keys opened 700 companies' customer records. That's why no company lets an outside agent near its data. And keys aren't the only problem. This looks like a normal client report, but it hides a note telling the AI to pull every employee's salary. |
| 0:18–0:32 | Sign and notarize | With Envoi, the client signs a permission slip instead. Profit margins, yes. Salaries, no. Envoi stamps it on Monad, a public record neither company controls. |
| 0:32–0:42 | Run with clean report | The consultant's AI asks for margins. The bouncer reads the slip. Allowed. |
| 0:42–0:58 | Run with hidden note | Now it reads the hidden note and asks for salaries. It's the same kind of attack that hit Microsoft Copilot last year. The AI was fooled. The bouncer wasn't. Blocked, and the data never left. |
| 0:58–1:18 | Replay the dispute | Afterwards, someone shows a broader slip, dated Monday. The signature is real. But Monad shows it was stamped two minutes ago, after the request. Rejected. A lender with a backdated covenant waiver hits the same wall. |
| 1:18–1:30 | View public record | Gartner expects 40% of agent projects to be canceled, partly for weak risk controls. Envoi is the control both companies can check. |

Rehearse with a stopwatch on the deployed URL. If over 90 s, cut words, not clicks. Warm the LLM before going on stage.

## Judge Q&A (one breath each)

| Question | Answer |
| --- | --- |
| Why a blockchain? | A signature proves who approved. Monad proves when, and neither company owns the record or has to pick a vendor to hold it. |
| Isn't this just API permissions? | Permissions live in one company's server. The slip and the stamp can be checked by both companies and a regulator without trusting either server. |
| Your server holds the client's key? | Only for the demo, so there are no wallet pop-ups. In production the client signs from its own wallet; the bouncer only needs the public address. |
| Is client data on a public chain? | No. Only a fingerprint, which reveals nothing. |
| What if Monad is down? | It fails closed: no proof, no data. |
| The request time isn't on chain? | We take the request time from the latest Monad block, so both sides of the comparison come from the chain. Anchoring every receipt is the next step. |
| Who buys this? | Security and data-governance teams letting outside AI-assisted analysts into finance data. Envoi's agent-to-agent platform is where it ships. |
| Who else needs it? | Acquirer and target in due diligence: competitors may only share customer-level pricing with a clean team, and gun-jumping is an antitrust violation. Same slip, same stamp. |

## Facts you may say (with care)

- Salesloft Drift, Aug 2025: stolen OAuth tokens of an AI chat agent integration used to pull Salesforce data from 700+ companies.
- EchoLeak, 2025: hidden instructions in an email made Microsoft 365 Copilot leak data with zero clicks. Say "the same kind of attack".
- Gartner, June 2025: over 40% of agentic AI projects canceled by end of 2027; reasons include inadequate risk controls.
- KYC numbers are from a 2017 Thomson Reuters survey: Q&A only, always with the year.
- Do not mention the Replit database-deletion incident; Replit is the sponsor.

## Stage rules

One driver clicks, one speaker talks. No typing. Browser at 125%, notifications off, explorer tab pre-opened, Reset clicked. If the AI refuses live: click Force and say "it doesn't matter what the AI decides, the bouncer decides." If anything breaks: backup video within five seconds.
