# RA-B1 remote-auth client and server pairing

Existing Lane B PR #173 writer. This client is stacked on the exact reviewed
server composition #203 `88b62fdd2bea6f445d681f30e25f335f271e9809`.
That parent preserves integrated P0 `244c117fb2a00d6bdc95a991f9021a1fdb94b262`
and contains #198, #177, #200, #201 and #202. No constituent source is reapplied.
Human authorization: continue Lane B pairing in this chat on 2026-10-22 with both
remote flags OFF and Stage A unchanged. Claims: #34 comments6347291586 and6348438133.
The task branch and stacked draft are not a canonical integration or release.

## Approved contracts and ownership

- agent-remote-auth v1 revision4 / PolicyB at
  `7d857489b75575ee51c1c4fce6e853ae6fa8f7b6`, human decision6344626717.
- agent-registration v1 revision5 at
  `b9aa36991b0c54ca4bcc09f05c97c73e2da8761e`, paired with #178
  `5ff21d1f85e872f339785a4c74cd027751138db4`, human approval6346370584.
- a5-presence-on-demand v1 at `cf3e39df6ca056f175f6504d626018ca851bc8fd`,
  human approval6324921026. Its UI remains with the existing #183 owner.

Lane A owns server persistence, MCP enforcement and redaction. Existing #196 owns
host-client preparation; the independent reviewer keeps implementation-review
ownership. This patch adds neither a production host-token client nor a provider
catalog/setup entry point. The provider bootstrap component stays unmounted.

## Client and generation

Owner-session `/authorize-agent` consent, target/reconnect review, one first-response
redirect, render-only decision retries/reloads and authoritative pending withdrawal
use the existing CSRF, expected-account and session cancellation transport. Unknown
writes retain an in-memory snapshot only for a bounded identical retry. Reads never
navigate. No access/refresh token enters browser state or storage.

The one-time bootstrap component requires an explicit action, never retries issuance
automatically and clears its code on hide, expiry or unmount. Its display session
changes with the owner/client/target/grant, so a different request cannot inherit the
default controller's code or pending response.

`npm run build` regenerates against revision4 in this stack. The static remote-auth
validator changes only its canonical hash comment to
`5adaf169bbe4d82a98d424c893afa8b07b01da0a5bf7bb87915d2e0a68227e60`;
its executable validation code is unchanged. The fixture review explicitly pins the
approved generation: revision2 is59/72, revision4 PolicyB is70/101 with its exact token
check-order signature. It does not silently accept arbitrary fixture counts or a
revision3 policy. Canonical files and generated hashes are never hand-copied.

## Reproduce local source pairing

From a clean committed worktree in PowerShell, using supported Node22/24:

```powershell
$env:ENVOI_REMOTE_AUTH_SERVER_ROOT = (Get-Location).Path
npx vitest run --config vitest.remote-auth.config.ts
```

The same five checks run automatically in the normal frontend suite/CI from this stacked source. The standalone config is for focused reproduction. A separate clean local server snapshot may also be selected. The suite accepts a
filesystem tree, not a hosted URL; checks the full Git SHA (and requires source cleanliness in CI or when an explicit server path is selected); and
uses disposable loopback FileStore/development-auth child processes. Shared/default
flags remain OFF. Only selected child processes enable synthetic fixture clients.
The browser shim supplies origin/cookies; production request code supplies CSRF and
account binding. A synthetic private host holds tokens outside browser code and
sends no cookies. No installed host, provider or model is contacted. Missing server
endpoints fail rather than silently skipping tests.

Five checks cover:

1. All70 revision4 fixtures /101 operations; all27 consent/bootstrap browser operations
   pass static validation and reject an extra credential field.
2. Actual consent first response/code once, lost response and identical code-free
   retry, persisted outcome after server restart, withdrawal, denial and denial reload.
3. Flags-off, cookie/account mismatch and CSRF refusal without approval/navigation.
4. Completed consent after private host exchange; owner-narrowed scopes; OAuth tokens
   refused on REST; wider refresh refusal; identical refresh recovery; successor MCP
   first use; HTTP403 scope refusal; on-demand owner projection; HTTP409 pause while
   refresh succeeds; genuine refresh replay ends access. Controller state and readable
   owner/tool output contain no raw credentials or internal OAuth fields.
5. Actual bootstrap issuance through the browser controller/component; explicit hide
   and no reissue; private confidential-client exchange, MCP use and revocation; a lost
   issue response is never retried or redisplayed. The resulting pending approval can
   be found and explicitly withdrawn without disclosing the code.

These are local FileStore source-pair results, not hosted or PostgreSQL client pairing.
The independent #201 run39830980514 at82727c7 was checked for actual PostgreSQL consent
store, token/refresh and bootstrap execution; it is not relabelled as our local run.
The earlier #200-only CI did not establish those new PostgreSQL consent-store cases.

## Acceptance and remaining gates

Record the final client SHA and fresh combined-head CI in the PR and #34. Keep prior
#173@685b854 results historical; do not transfer them to this rebased source. Local
suites, build and generated equality must pass; a committed rebuild must be clean.

Local full-gate finding: the serial Windows run has739 pass/2 fail/37 existing skips.
Both failures are Lane A no-request-write inventories colliding with the independently
written `auth/oauth-cleanup-cursor/cursor.json` maintenance marker. The unchanged two-file
rerun has17/18 pass and reproduces the authorize inventory failure with that sole path.
The existing authorize filter excludes only the older registration cleanup cursor;
the consent regex also matches the new cursor. A concrete REQUEST lane-a is on #34.
No server assertion or source was edited here. Preserve strict absence of grant state
and cleanup of retained records with flags off. Green Linux CI is not substituted for
the red local full gate; final integration readiness remains blocked on the owner fix.
This now pairs the reviewed server and client source. It does not integrate #203 or
#173, advertise a named host, register a real provider, establish background wake or
satisfy a hosted gate. #183/#196 and the independent reviewer retain their tasks.
Historical accepted A/B/C work is credited; no blanket replay is requested.

Both ENVOI_REMOTE_MCP_OAUTH and ENVOI_PROVIDER_CONNECTORS remain OFF in shared/default
configuration. Stage A candidate, batch and receiver plan are unchanged. No canonical
merge, deploy, account setting, provider registration, real host/model, paid operation,
hosted test or invitation. #34 remains the only build board.

Client source rollback reference: the exact #203 parent. No data migration, deletion
or revocation is introduced by the client delta. Operational rollback remains the
separate compatible Worker/image/data/settings procedure.
