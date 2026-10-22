# P0 release guard completion

The human explicitly reassigned the required P0 server/configuration edits to this chat on 2026-10-21 (America/New_York). This source work does not authorize deployment, account settings, billing, real runtimes, or invitations. The existing human-owned build plan and canonical contracts are unchanged.

## Fixed deployment paths

| Path | Previous gap | Result |
| --- | --- | --- |
| `npm run cf:deploy:staging` | Clean source/SHA checks ran, but existing production secret-name checks were absent | The staging application and dedicated staging scanner names must both pass before Wrangler deployment |
| `node scripts/promote-release.mjs staging SHA --deploy` | Application names checked, scanner inventory omitted | Uses the same application-plus-scanner staging validator |
| `npm run cf:deploy:beta` | Secret names checked, but the direct build path could deploy dirty or unmerged HEAD despite the stricter promotion script | Fetches `origin/main`, reads full HEAD/main identities and tracked/untracked cleanliness, then reuses `promotionPlan` before secret access or deployment |

The existing legacy encryption-key alias remains supported. Names are listed without fetching or logging secret values. Both scanner configurations remain isolated. Staging still permits a reviewed clean integration candidate; beta requires exactly fetched main. A failed Git refresh, invalid SHA, divergent/unmerged source, dirty worktree, missing encrypted application name or missing dedicated scanner token stops the relevant deployment path. No deployment command was executed during validation: tests replace Wrangler and use temporary local Git remotes.

## Candidate and accepted tests

The final review candidate combines this guard change with the client source from PR #192 (the #174/#184 composition) once. Do not apply both the candidate and its constituent source increments again. Prior B/C testing is human-attested complete/countersigned in [the canonical board record](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176); its missing historical transcription is not a blanket rerun request. Later source changes and their local/CI results are identified separately in the PR.

## Remaining actual inputs and operations

1. Human selects and integrates the exact reviewed release, reconciles it with main for beta, and records Worker/image plus served/installed artifact identities. Nothing here merges or deploys it.
2. Account operator privately confirms the live database destination, recovery of application data/files/queue/key material, and the retained Worker/container rollback pair. Existing restore parity and completed tests are credited; attach existing observations rather than repeat them by default.
3. Operator verifies/provisions only missing approved beta configuration: policy signing key/keyring, bucket-scoped S3 credentials, beta application scanner token matching the beta scanner's `ENVOI_SCANNER_TOKEN`, admission allowlist, WorkOS secrets and database URL. Preserve the existing `SINALOA_DATA_ENCRYPTION_KEY`. Confirm scheduled backups/retention and delivered operational alerts; rotate/test the recorded R2 credential before its October 29 expiry.
4. Production WorkOS remains dependent on the separately deferred billing/unlock decision. The actual Production client ID/environment binding is not available in this task. Do not replace the currently pinned ID with a placeholder or claim Staging is Production. After that binding exists, update reviewed `wrangler.jsonc` and its pinned configuration expectation, privately configure the matching API/cookie secrets and exact HTTPS callback, and verify the Production login/admission/session/logout behavior.
5. Decide existing owner/workspace data continuity before the WorkOS switch. Preserve data and runtime credentials. If an identity mapping is needed, its actual source/target provider identifiers and approved mapping are prerequisites; never infer a same-person mapping from email alone. No fabricated migration is included.

The source/configuration edits are prepared here under the explicit ownership exception. The remaining account-specific values and human-operated release steps cannot be completed by inventing credentials, Production IDs, restore evidence or a deployment result.
