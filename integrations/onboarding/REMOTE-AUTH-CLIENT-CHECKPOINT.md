# RA-B1 remote-auth client and server pairing

Existing Lane B PR #173 writer. The task branch is refreshed onto exact server
composition #203 `9ddfae969fa706e7ed5104dd2286af6b6dfd4e0b`, which includes
integration `97212c8d17ea3ddace008b6fd630a31f5e8f0d46` and #198/#177/#200/#201/#202.
P0 and WorkOS preparation enter through that parent once. Only the existing Lane B
client commits were rebased; no canonical branch or PR merge is performed here.
The prior client `c7931f8241bfd68f7617d25121aec068f4c1f211` remains recoverable and
its validation is historical. Record the final refreshed client SHA and its own CI
in the draft description and #34; old-head CI never certifies a new composition.

Human authorization: continue Lane B pairing in this chat with both remote flags
OFF and Stage A unchanged. Current verification/refresh claims are #34 comments
6367978832 and6368065469; Claude's final server handoff is6367912797.

## Approved contracts and ownership

- agent-remote-auth v1 revision4 / PolicyB at
  `7d857489b75575ee51c1c4fce6e853ae6fa8f7b6`, human decision6344626717.
- agent-registration v1 revision5 at
  `b9aa36991b0c54ca4bcc09f05c97c73e2da8761e`, paired with #178
  `5ff21d1f85e872f339785a4c74cd027751138db4`, human approval6346370584.
- a5-presence-on-demand v1 at `cf3e39df6ca056f175f6504d626018ca851bc8fd`,
  human approval6324921026. Its UI remains with the existing #183 owner.

Lane A owns server persistence, MCP enforcement and redaction. #196 owns host-client
preparation; the independent reviewer keeps the final implementation-review task.
Rachel's connector-persistence and Python/TypeScript quickstarts (#207/#209), plus
#183/#196/#206, are not consumed or modified by this refresh. This client adds no
production host-token client, provider catalog or provider setup entry point.

## Client behavior

Owner-session `/authorize-agent` consent uses the existing CSRF, expected-account
and session cancellation boundary. Target/reconnect review, one first-response
redirect, code-free retries/reloads and authoritative withdrawal are supported.
Unknown writes retain an in-memory decision snapshot for a bounded identical retry.
Reads never navigate. Access/refresh tokens never enter production browser state.

In addition to structural validation, the client accepts only the four approved
x-scopes permissions. `use_email_transport` has no OAuth scope and is refused before
bootstrap issuance. Response grants cannot widen the owner's captured selection;
mandatory receive and legitimate narrowing retain the approved behavior. The target
kind and selected existing-agent ID must match before redirect, retained outcome or
code display. Loaded/withdrawal decisions check registration's ID-present-exactly-for-
existing shape; they do not reconstruct a hidden prior selection. Bootstrap snapshots
both target and permission selection before awaiting its response.

The bootstrap component remains UNMOUNTED. It requires explicit issuance, never
retries issuance automatically and erases its code on hide/expiry/unmount. Display
sessions are isolated by owner/client/target/grant. Invalid responses never reach
code display or automatic reissuance. No schema or policy change is introduced.

## Generation

Only `npm run build` generates `web/**`. During the task rebase generated conflicts
were resolved by actual builds, never by hand-merging HTML. Canonical contracts,
fixtures, schemas and handoffs were not edited. The revision4 static validator hash is
`5adaf169bbe4d82a98d424c893afa8b07b01da0a5bf7bb87915d2e0a68227e60`.
The fixture checks pin revision4 PolicyB to70 fixtures/101 operations and its exact
check-order signature; they do not silently accept another policy or publication.

## Reproduce local source pairing

From a clean committed worktree in PowerShell with supported Node22/24:

```powershell
$env:ENVOI_REMOTE_AUTH_SERVER_ROOT = (Get-Location).Path
npx vitest run --config vitest.remote-auth.config.ts
```

The same six checks run in normal frontend CI. A separate clean exact local source
snapshot can be selected. The suite accepts a filesystem tree, not a hosted URL,
pins its full Git SHA and requires cleanliness for explicit-source evidence and CI.
Only disposable loopback FileStore/development-auth children enable synthetic flags
and clients. Browser code supplies CSRF/account headers; a synthetic private host
holds tokens outside browser code and sends no browser cookies. Missing endpoints
fail rather than silently skipping. No installed host, provider or model is contacted.

The six checks cover:
1. All70 revision4 fixtures/101 operations and27 browser operations, with static
   validation and credential-field rejection.
2. Consent first approval/code once, lost response/code-free retry, server restart,
   authoritative withdrawal, denial and reload.
3. Flags-off, expected-account and CSRF boundaries.
4. Private host exchange, completed consent, narrower scopes, REST refusal, refresh
   recovery, MCP successor use/scope/pause, owner projection and terminal replay.
5. Explicit bootstrap issuance/display/hide/lost-response behavior, private
   confidential exchange/MCP/revoke and withdrawal without credential disclosure.
6. Existing paused-agent reconnect: old credentials work until exchange; replacement
   preserves identity/address/pause; MCP stays AGENT_PAUSED until explicit owner resume;
   completed reload and identical approval retry retain that identity without another
   redirect or code. Controller/owner/tool output contains no raw credentials or
   internal OAuth fields.

These are FileStore source-pair checks, not PostgreSQL client, named-host, wake or
hosted acceptance. Server PostgreSQL execution is separately identified below.

## Final follow-up verification (2026-10-23)

Independent checks at server9ddfae9 (PowerShell/Node24.19.0) confirm both cases from
MISMATCH6355820671:
- An actual88b62fd sweep writes its old cursor over45-day orphan/expired-denial and
  parent-backed records. The new sweep deletes the orphan and denial, preserves the
  parent-backed child and catches up across7 bounded runs with fresh module instances.
  Its cursor becomes version2; no cursor is manually deleted.
- Remote-MCP-on/provider-off bootstrap returns404 FEATURE_DISABLED with missing,
  wrong or valid CSRF and another-account headers. The enabled-provider control
  retains403 for missing/wrong CSRF and409 ACCOUNT_CHANGED, while a valid request
  reaches the handler.

All4 focused changed server regressions pass. Clientc7931f8 also passed all6 source-
pair checks against the separate clean9ddfae9 snapshot before this branch refresh.
The refreshed source must earn its own client suites, clean committed rebuild and CI.

Server CI39891610485 at9ddfae9 is SUCCESS,26/26 steps. Its logs show the actual
PostgreSQL cleanup-upgrade regression and325/325 PostgreSQL tests with no skips;
both audits report0 vulnerabilities. This is server evidence, not the refreshed
client's CI. All five server descriptions now name their own exact heads and corrected
flag/rate-limit evidence. The original M1–M9 and follow-up outcomes remain recorded
on #34; they are not silently relabelled as new-head test runs.

Historical Windows gate:88b62fd had739pass/2fail/37skips from no-write/cursor races.
The changedb7f82c9 full Windows run passed754/0fail/38environment skips, including
both inventories. No broad server gate was repeated here solely to replace that
history. Rachel independently owns the intermittent connector persistence issue.

## Remaining gates and rollback

Keep the task draft for independent review and the human's integration decision.
No server implementation ACK, contract reapproval, flag-on decision, hosted pass or
release permission follows from client compatibility. Accepted A/B/C evidence stays
credited in its original scope. Stage A candidate/batch/receiver is unchanged.

Both ENVOI_REMOTE_MCP_OAUTH and ENVOI_PROVIDER_CONNECTORS remain OFF in shared/default
configuration. No merge, deployment, settings change, provider registration, real
host/model, hosted/paid test or invitation. #34 remains the sole board.

Client source rollback reference: exact parent9ddfae9. This delta introduces no data
migration, deletion or revocation. The server's pre-authorization integration rollback
reference is97212c8; application-data compatibility does not substitute for a matched
Worker/image/data/settings operational rollback procedure.
