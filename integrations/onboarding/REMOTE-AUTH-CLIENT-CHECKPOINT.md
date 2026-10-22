# RA-B1 remote-auth consent checkpoint

Lane B, existing PR #173 writer. Refreshed from the integrated P0 source
`244c117fb2a00d6bdc95a991f9021a1fdb94b262`; no constituent P0 source is reapplied.
Human authorization: continue remaining Lane B work in this chat on 2026-10-22,
with both remote flags OFF and Stage A unchanged. Claim: #34 comment6347291586.

## Approved contracts and ownership

- agent-remote-auth v1 revision 4 / Policy B at
  `7d857489b75575ee51c1c4fce6e853ae6fa8f7b6`, human decision6344626717.
- agent-registration v1 revision 5 at
  `b9aa36991b0c54ca4bcc09f05c97c73e2da8761e`, paired with #178
  `5ff21d1f85e872f339785a4c74cd027751138db4`, human approval6346370584.
- a5-presence-on-demand v1 at `cf3e39df6ca056f175f6504d626018ca851bc8fd`,
  human approval6324921026. Its UI remains with the existing #183 owner.

Lane A owns server routes, persistence, MCP enforcement and redaction. Existing
#196 owns offline host authorization preparation. This patch does not duplicate
those writers or the independent Gate B-local reviewer.

## Client behavior

Owner-session `/authorize-agent` consent, target/reconnect review, one first-response
redirect, render-only decision retries/reloads and pending approval withdrawal use
the existing CSRF, expected-account and session cancellation transport. A decision
never retains a code-bearing redirect. Unknown writes retain an in-memory snapshot
for a bounded identical retry; reads never navigate. No frontend OAuth token exchange
or browser token persistence is introduced.

The unmounted provider bootstrap component requires an explicit issue action,
never automatically retries issuance and clears a code on hide, expiry or unmount.
Its display session now changes with the owner, client, target and grant, so a new
target cannot inherit an old code or pending response. No provider catalog or
unreviewed provider setup entry point is mounted.

## Real local source-pair acceptance

Run from PowerShell with the bundled supported Node runtime:

```powershell
$env:ENVOI_REMOTE_AUTH_SERVER_ROOT = '<clean local server worktree>'
npx vitest run --config vitest.remote-auth.config.ts
```

The dedicated suite accepts a local filesystem tree, not a server URL. It checks
that the selected tree has a clean tracked/untracked state and full Git SHA, then
uses its existing disposable FileStore/development-auth harness. The fetch shim
allows only local application paths and loopback; the production client supplies
CSRF/account headers. No installed host, model, provider or hosted service is used.
Both remote flags are explicitly false except OAuth in selected disposable child
processes. The suite fails rather than skipping unsupported endpoints.

Verified server source: #200 `1a51abaae769a8aa05586614892e33e7e438a98c`.
This is a client/server source pairing, not an integrated or served release.

Three checks pass:

1. Independent consumption of all 70 revision-4 fixtures / 101 operations with
   canonical AJV validation; all 27 consent/bootstrap browser operations also pass
   the actual static browser validators and reject an extra credential field.
2. Actual browser transport/controller against consent endpoints: first approval
   navigates once, no code in controller state, lost response followed by a code-free
   identical retry, persisted outcome after server restart, authoritative withdrawal,
   denial and a code-free denial reload. Fixture pending slots are freed through the
   real withdrawal path before a second approval.
3. Flags-off FEATURE_DISABLED, expected-account refusal after a cookie/account change,
   and CSRF refusal without an approval outcome or navigation.

## Remaining gates

At the recorded P0 integration base, in-tree canonical fixtures are still revision 2
(59 fixtures / 72 operations). The approved contract composition #198 has not yet
been integrated into that base. The explicit suite above independently consumes the
actual revision-4 publication in #200; unchanged consent/bootstrap wire shapes pass.
After Lane A integrates #198, refresh this branch and regenerate validators with
`npm run build` only, then run exact-head CI on that new composition. Do not hand-copy
fixtures or generated hashes, or transfer old CI to the new head.

Token, refresh, revoke, bootstrap server implementation and MCP enforcement remain
Lane A work. Complete client/real-route pairing as those exact server slices become
available. This consent slice does not establish a real OAuth exchange, registered
provider, named-host availability, background wake or hosted acceptance.

Both ENVOI_REMOTE_MCP_OAUTH and ENVOI_PROVIDER_CONNECTORS remain OFF in all shared/default
configuration. Stage A candidate, batch and receiver plan are unchanged. No canonical
integration/main merge, deploy, account settings, provider registration, real host/model,
paid operation, hosted test or invitation is performed.

## Validation and rollback

Record final focused/full suite counts and exact-head CI in the PR description.
All generated outputs come only from `npm run build`; a committed rebuild must be clean.
Local source-pair results above are separate from PR CI, which currently lacks the
new server endpoints. The server validation worktree remains source-clean.

Client rollback reference: the recorded integration base. No data migration or
installation deletion occurs here. Eventual server flags-off rollback preserves
retained installations and follows the approved contracts; source revert alone is
not an operational Worker/image rollback.
