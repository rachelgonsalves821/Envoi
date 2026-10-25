---
name: replit-ship
description: Deploy, verify and protect the Envoi app on Replit - Reserved VM deployment, workspace vs production secrets, port/boot rules, post-deploy smoke test, git commits at gates, rollback etiquette and credit-saving Agent habits. Use when deploying, when the deployed app behaves differently from the workspace, or before any rehearsal.
---

# Shipping on Replit

## Deployment settings

- **Type: Reserved VM** (one always-on machine). Not Autoscale: it can scale to zero or run several instances, each with its own in-memory slips and receipts. If Reserved VM is unavailable, Autoscale with max instances = 1.
- **Run command** starts one process that serves the API and the built Vite client. Server listens on `0.0.0.0` and `process.env.PORT`.
- **Homepage must answer within ~5 s** or publishing fails. No RPC or LLM calls at boot.
- **Every redeploy wipes in-memory state.** Plan ~4 deploys: after Gates 1, 2, 3 and the final one at about 2:15. Use Reset before each run-through.

## Secrets (the #1 deploy bug)

Workspace Secrets do not always carry over to the published app. In the Publishing / deployment settings, confirm these exist as production secrets:

- `ISSUER_PRIVATE_KEY`
- `MONAD_RPC_URL`
- `MOCK_CHAIN` = `0` (or unset) from Gate 2 on
- `ANTHROPIC_API_KEY` (backup) and `USE_OWN_KEY` if you switch
- The Anthropic AI integration (re-check it is attached to the deployment)

Add a boot guard so a missing secret fails loudly instead of silently mocking:

```ts
for (const k of ["ISSUER_PRIVATE_KEY"]) {   // MONAD_RPC_URL has a default in ledger.ts
  if (!process.env[k] && process.env.MOCK_CHAIN !== "1") { console.error(`Missing secret ${k}`); process.exit(1); }
}
```

## Smoke test after every deploy (2 minutes)

1. `GET <url>/api/health` → `ok:true`, `mockChain:false`, issuer address shown.
2. `GET <url>/api/selftest` → `pass:true`; note each step's `ms` (each scene must be < 8 s).
3. Click through the six buttons once in the browser at 125% zoom.
4. Open one explorer link.
5. `POST /api/reset` so the stage run starts clean.

If health works but selftest fails only on the deployed URL, it is almost always a production secret.

## Dev URL vs deployed URL

The workspace dev URL can be private to collaborators and can change when the Repl reopens. Demo and submit the **deployed** URL. Keep the dev URL only as a last-resort fallback, opened in a logged-in browser.

## Git discipline

- Connect GitHub in Tools → Git. Commit and push at every gate with the gate name: `gate-2: scenes 1, 2a, 2b on real chain`.
- Never commit keys. `.env.example` lists names only.
- Before anyone uses Agent rollback: say it out loud. Rollback restores every file, including teammates' hand edits. Only P3 (the Agent driver) rolls back.

## Agent modes (save credits, all usage bills to the project owner)

| Task | Mode / effort |
| --- | --- |
| Questions, "where is X" | Free |
| Scaffold, chain code, a bug that survived two tries | Max, Medium–High (Extra High for the stuck bug) |
| Routes, gateway, UI iterations | Power, Medium |
| Copy and colour tweaks | Power, Low, or edit by hand |
| Final click-through (App Testing) | Power, Low, name the exact six-button flow |

Write prompts as one change each, name the files that must not change, and end P3 prompts with: "Do not modify files in server/chain, server/gateway, server/data or server/agent."

## Backup

By 2:45, record a clean run of all scenes on the deployed URL. If anything fails on stage, switch to the recording within five seconds.
