# P0 completion handoff

Direct human assignment: complete the whole P0 implementation in this chat. Prior B/C tests were explicitly confirmed complete and countersigned on 2026-10-21 (America/New_York). The [attributed board record](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176) corrects the earlier audit's blanket missing-test label. [Phase C client status](phase-c/EVIDENCE.md) retains the evidence boundary.

## Client implementation in this branch

Base: `integration/agent-native` at `bbd361ea52aab80fc53c402130a35718f6bee561`.

| Source | Selected content | Original PR disposition |
| --- | --- | --- |
| #174 `fe08471c81decaee5d3d6d6563e7b45dceac23ef` | Exact Windows handle/inode wake-file identity validation and regression tests | Original branch left untouched |
| #184 `6f5176e2b0cf53b92d09edc85ae07c8940be6707` | Normal Hermes/shared and OpenClaw entrypoints compose one scoped host, loopback receiver and canonical poller; manual launchers, operator guide and tests | Lane B source only; no Lane A hosted packet copied |
| This branch | Enable the five previously Windows-skipped composition checks with #174 included; assert canonical POST claim/body in the simulated normal-entry service | New combined-client validation |

Generated `web/**` comes exclusively from `npm run build`. Select this combined client delta once; do not also apply #174 and #184's same source changes on top. This preparation does not update the integration branch or select the human's final release.

## Remaining P0 actions and ownership

| Item | Existing result to preserve | Remaining concrete action | Owner |
| --- | --- | --- | --- |
| Historical A/B/C acceptance | Phase A recorded closeout; B-local 21/21; direct B/C human countersign | Link historical release/row records in canonical Lane A evidence; no blanket rerun request | Lane A reconciliation |
| Client composition | Source assembled here from existing reviewed fixes | Review this exact head and its build/Windows/CI results; integrate selected delta once | Lane A integration / Lane B verification |
| Final release identity | Existing gated source and artifacts remain historical | Choose resulting release SHA, image, Worker, served/installed hashes and applicable changed-behavior checks | Human with Lane A |
| Recovery | Staging/beta database restore parity already recorded in #185 | Privately match live DB destination; verify app/file/queue/key recovery and paired Worker/image rollback for the selected release | Lane A / account operator |
| Beta service configuration | Dated secret-name, scanner, backup and R2 observations in #185 | Verify/provision required private configuration; authenticated scanner test, scheduled snapshot/retention and delivered alerts; rotate/test dated R2 credential before expiry | Lane A / account operator |
| Production authentication | Existing WorkOS code and preparation packet on #34 | Deferred human billing decision, actual Production environment bindings and identity continuity; implement any reviewed mapping/configuration, then bounded sign-in/admission/reconnect/logout/recovery checks | Human / Lane A; Lane B checks affected UI |
| Release and invitations | No new release or invitation implied | Human performs approved merges/deployments/settings and signs the exact permitted cohort/routes after remaining P0 exits | Human only |

Current known matched staging baseline is Worker `0c075364-f7c0-458c-a297-edd05e72abe1`, container v57 image `sha256:cf918d33dcfbf8c561c64b4f1f6c7a2f6a9bee61410d9b8e67018b71904a522f`, release `2b18170d59b0096ff997d9a79487d50ccb627ef9` ([operator record](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6327296775)). Re-read before a future operation; do not treat this historical pair as a rehearsed rollback.

The initial assignment followed Lane B ownership. The human subsequently explicitly reassigned required P0 server/configuration edits to this chat ([board record](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6331012537)). The release-script guards are now included in this same candidate; see [the completed guard changes and remaining inputs](../../docs/p0-release-guards.md). Canonical contracts and other active task branches remain untouched. Actual account configuration, billing, integration/release operations and unavailable Production identity bindings remain separate prerequisites. Remote OAuth/provider routes are conditional on the selected cohort and retain their own approved-contract dependencies; no extra Muse, Instinct, Dots or Grok acceptance is inferred.

## Exact configuration handoff (names only)

The existing promotion guard and production configuration already implement these checks; do not build a second release or secret-management system.

| Target | Names / action |
| --- | --- |
| Beta application Worker | Verify `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `ENVOI_BETA_INVITED_EMAILS`, `ENVOI_POLICY_SIGNING_KEY` (or `ENVOI_POLICY_SIGNING_KEYS`), `ENVOI_S3_ACCESS_KEY_ID`, `ENVOI_S3_SECRET_ACCESS_KEY`, `ENVOI_MALWARE_SCANNER_TOKEN`. Provision only the missing approved values privately. |
| Existing storage encryption | Preserve the existing `SINALOA_DATA_ENCRYPTION_KEY`. `worker/runtime-config.js` explicitly forwards that supported legacy name as `ENVOI_DATA_ENCRYPTION_KEY`. Its absence under the newer name alone is not a missing-key defect. Do not rotate/recreate it as part of this release. |
| Beta scanner Worker | `ENVOI_SCANNER_TOKEN` must match the application's beta-only `ENVOI_MALWARE_SCANNER_TOKEN`; retain staging/beta separation and prove authenticated scanner health. |
| Production WorkOS | After the human's deferred billing/unlock decision, pin actual Production `WORKOS_CLIENT_ID`, API key, issuer and `WORKOS_REDIRECT_URI` to the approved HTTPS app origin. Review cookie/session/MFA/admission and owner identity continuity before switching; no identity is silently remapped by email. |
| Root configuration | Lane A reconciles actual Production bindings in `wrangler.jsonc` and the existing pinned expectations in `scripts/check-deployment.mjs`, plus any approved identity mapping with rollback. No placeholder Production ID is supplied by this branch. |

`scripts/promote-release.mjs` requires the live promoted SHA to equal fetched `origin/main`, and checks application/scanner secret names. `scripts/deploy-staging.mjs` is the separate clean-worktree exact-HEAD staging path. The human/Lane A should select one reviewed route and resulting SHA rather than assume an integration-only hosted SHA will promote unchanged.

## Offline checks

Run in PowerShell at this branch's exact head:

```powershell
npx vitest run --config integrations/vitest.config.ts integrations/connector/hosted-wake-entry.test.ts integrations/connector/hosted-wake-runner.test.ts integrations/connector/http-wake-store-identity.test.ts integrations/connector/http-wake-store.test.ts integrations/connector/http-wake-driver.test.ts integrations/connector/http-wake-host.test.ts integrations/connector/http-wake-http.test.ts
npm run typecheck
npm run test:frontend
npm run test:sdk:typescript
npm run test:integrations
npm run test:sdk:python
npm run build
npm test
```

The composition tests use temporary private state, loopback listeners and simulated service/runtime responses. They do not enroll agents, contact a real Gateway/model, send live messages, mutate hosted services or replace the historical human countersign. No remote auth flag, infrastructure setting, secret, billing state, existing runtime profile or paused case is changed.
