# Cloudflare runtime configuration status

The Worker `sinaloa` Production settings were checked in a signed-in Cloudflare dashboard on 2026-09-28. Historical observations below describe that snapshot. The fresh account check below is the current evidence. Rachel's release order is **isolated staging acceptance first**, then promotion to the invite-only beta at `beta.sinaloa-inbox.com`.

## Fresh account check — 2026-09-29

- Rachel authorized Neon Console's read-only GitHub email access, and a new **Neon `sinaloa-beta` PostgreSQL project** was created in AWS US East 2 (Ohio), project ID `dry-tooth-12968475`. Its default `production` branch contains database `sinaloa_beta` on PostgreSQL 18. Reserve this for later beta promotion; it is **not** an isolated staging database. The project is on Neon's Free plan with a **6-hour history retention** window. Its connection secret has not been entered into Cloudflare, migrations have not run, and a restore test is still open. A longer retention/backup policy is needed before real-user beta signoff.
- A separate **Neon `sinaloa-staging` project** was created in the same region, project ID `dry-poetry-47244003`, with PostgreSQL 18 database `sinaloa_staging`. It is a distinct project for test-only staging data. All four checked-in SQL migrations (`001`–`004`) were applied in one transaction through Neon's SQL Editor on 2026-09-29. The editor reported a successful `COMMIT`, and a post-commit query returned four migration records with checksums matching the repository files. A manual snapshot was then created and restored to a **new branch** (`br-nameless-wind-b4bliwv3`) without changing the active branch; a query on the restored branch returned the same four migration records and checksums. The free project permits one manual snapshot and reports a six-hour point-in-time history window. The staging Worker now holds the database URL as an encrypted secret, but live application TLS/CRUD tests remain open.
- Cloudflare R2 is now active. The R2 integration owner created a private Standard `sinaloa-staging` bucket in Eastern North America with public access disabled and CORS limited to the staging Worker origin. A 30-day Object Read & Write credential restricted to that bucket is active through 2026-10-29. `SINALOA_S3_ENDPOINT`, `SINALOA_S3_BUCKET`, and its two encrypted S3 credentials were saved on the staging Worker. On 2026-09-29 the R2 owner passed a live signed-object smoke test against this bucket: upload, metadata verification, download, invalid-key rejection, and deletion. The test exposed a zero `Content-Length` on signed HEAD despite a nonempty signed GET; adapter fallback and unit coverage were committed as `d8f51e8`, and the live test passed after that fix. The deployed app's R2 read readiness passed; hosted asset upload, scanner/R2 quarantine and revocation still need acceptance. No beta bucket or credential has been provisioned; renew or rotate the staging token before expiry if testing continues.
- The isolated `sinaloa-staging` Worker is connected to `codex/staging-readiness` in Cloudflare Builds with `npm run build` and `npx wrangler deploy --env staging`, using the existing `sinaloa build token`. Build `7f34990b-1ec2-46e4-ae6a-cad893712539` completed successfully for commit `1cfd521` on 2026-09-29 and deployed Worker version `edb35832-e42f-4507-9155-fea289e23e52`. Cloudflare created the `sinaloa-beta-staging` Container application `a03cd3b2-67bf-4626-8444-e89d9114fcb9` from image digest `sha256:6e57b73f2781ac02b2f0bb62f50eaacf0513efcf44d40df2d74523c0979ded28`; its instance was observed Running. The staging URL is `https://sinaloa-staging.rachelgonsalves821.workers.dev`. The old `sinaloa` Worker was not changed by this rollout.
- The first app Container start failed because the staging database migration ledger held SHA-256 checksums of Windows CRLF working-tree files. Git tracks the four migration files as LF, and the Linux Container compared against those LF bytes. The SQL content and migration IDs were the same. After confirming all four recorded values exactly matched the CRLF files, only the **staging** ledger checksums were changed in one guarded, atomic `DO` block to the corresponding immutable Git LF hashes. No migration SQL, business table or beta/production database was changed. The old/new checksum pairs are: `001_documents.sql` `6eb29859…` → `a3ea83cb…`; `002_object_storage.sql` `1e871039…` → `f002b441…`; `003_delivery.sql` `446b9e0d…` → `c5cd1a38…`; `004_history_indexes.sql` `c1f5b2ad…` → `f7cd8b59…`. A post-update query returned all four expected Git hashes.
- After that correction, the hosted `/health` returned HTTP 200 with `configurationValidated:true`, and `/ready` returned HTTP 200 with PostgreSQL, R2 read access and malware scanner all `ready:true` at 2026-09-29 21:03 UTC. The hosted UI rendered its invited WorkOS sign-in screen, `/api/auth/config` reported `provider:workos`, the sign-in link reached the staging AuthKit application, and the hosted phone-sign-in endpoint returned 404. This proves infrastructure readiness, not two-human MFA, case, asset, restart or revocation acceptance.
- The failed `sinaloa` build produced a Container image and uploaded the Worker, then failed during the Cloudflare Containers API deployment step. That build used `main` at `cc86af3`, before the current partner/R1/R2 integration work. Retrying that old build would not validate the release candidate.
- The existing `sinaloa build token` completed the isolated staging Container build and deployment at `1cfd521`; effective staging Containers deployment permission is therefore demonstrated. Its full permission list and least-privilege scope have not been audited.
- The integrated partner/R1/R2 code at merge commit `cc539d5` passed 99 backend tests (8 live-provider/PostgreSQL skips), 58 frontend tests, 37 TypeScript SDK tests, typecheck/production build, six Worker tests, and both Wrangler dry-runs in an isolated checkout. These checks precede the latest R2 branch commits and must run again on the final head. Rachel authorized a minimal-scope Wrangler OAuth grant; `wrangler whoami` confirms account `54a5d6c680bd813fa60f8e088b098b8d` and `workers_scripts:write` plus `containers:write`. The credential is stored in an encrypted Wrangler file with its key in Windows Credential Manager.
- `sinaloa-inbox.com` is active in this Cloudflare account, with full DNS setup and Workers Paid listed. Its zone overview reports **no Workers connected**; public DNS has no `beta.sinaloa-inbox.com` record yet. The hostname can be bound only after the beta Worker serves the reviewed release.
- The signed-in WorkOS dashboard has a `Sinaloa Beta` application in its **Staging** environment with origin-bound URLs at `https://beta.sinaloa-inbox.com`; it remains reserved for later beta work. With Rachel's approval, a separate `Sinaloa Staging` application was created in that same WorkOS environment, with client ID `client_01M3PPK3NRG58NWNVKNES9CTRV` and callback, homepage, initiate-login, and sign-out URLs bound to the staging Worker origin. A new app-scoped test API key was stored as a Cloudflare encrypted secret; its value was not put in chat or Git. WorkOS users and organizations are still shared inside the WorkOS Staging environment, so application separation is not full identity-data isolation. Live sign-in remains unverified.
- The staging Worker's runtime table contains 15 origin-bound non-secret variables and nine encrypted secrets: `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `SINALOA_DATA_ENCRYPTION_KEY`, `SINALOA_POLICY_SIGNING_KEY`, `SINALOA_S3_ACCESS_KEY_ID`, `SINALOA_S3_SECRET_ACCESS_KEY`, `SINALOA_BETA_INVITED_EMAILS`, and `SINALOA_MALWARE_SCANNER_TOKEN`. The scanner URL is set by the staging Wrangler environment. The two human tester addresses were saved only in the encrypted invite allowlist, never in Git. The three generated application keys are independent and staging-only. The database URL is the direct Neon staging connection with URL TLS parameters removed so `SINALOA_DB_SSL_MODE=verify-full` controls certificate validation. The beta Worker's runtime table was not changed.
- Hosted sign-in uses WorkOS AuthKit authenticator-app MFA and the exact invited-email allowlist. Live provider MFA with both invited humans remains unverified; SSO must not bypass the MFA gate without an equivalent enforced identity-provider policy.
- A separate `sinaloa-scanner-staging` Worker and `sinaloa-clamav-staging` Container were deployed with the official ClamAV image. ClamAV listened on private TCP port 3310 and loaded signatures. The first readiness implementation failed because Cloudflare's Container helper probed that raw-TCP port using HTTP. The corrected staging Worker uses direct TCP readiness. Live direct probes passed: authorized `/health` returned `200 {"ready":true}`, clean content returned `clean`, the EICAR sample returned `infected` with `Eicar-Test-Signature`, unauthenticated `/health` returned `401`, a bad checksum returned `422`, and a 25 MiB plus one byte body returned `413`. The scanner credential is an encrypted secret on its Worker and the deployed app Worker. The staging scanner URL is a non-secret staging-only Wrangler variable. Cold-start, scheduled warm-up, signature freshness and combined R2 quarantine acceptance remain open.
- The staging app Container and its critical dependency readiness are live. There is still no verified beta Worker, beta runtime secret table, or two-human/provider/case acceptance. A healthy staging service is not yet a signed-off beta.
- The first deployment target is the separate `staging` Wrangler environment and isolated test-only providers. Promote the exact accepted commit to the invite-only **beta** at `beta.sinaloa-inbox.com`, with native addresses under `agents.sinaloa-inbox.com`, only after hosted acceptance. Keep the existing `sinaloa` Production Worker and its data untouched until the reviewed candidate is ready.

## Current account check — 2026-09-28

- The signed-in account's **Workers Paid** card showed **Current plan**, and its highlights list Containers. This verifies the account entitlement, not a working deployment or the Builds token's `Containers Edit` permission.
- R2 still redirected to `/r2/plans` and showed **Add R2 subscription to my account**. No R2 bucket or live signed-object test is available yet. The account owner must complete the billing/terms step personally before staging storage can be provisioned.
- `wrangler whoami` still reported **not authenticated** on this computer. No staging Worker, Container, PostgreSQL database, WorkOS environment, scanner, or runtime secret was provisioned by this check. The local process environment did not contain the required provider credentials.
- Use the separate `sinaloa-staging` Worker configuration and staging-only provider resources. Do not use the existing Production Worker or its data for beta acceptance.

## Follow-up verification — 2026-09-28

- The recovery branch now defines a separate Wrangler `staging` environment (`sinaloa-staging`) with its own Container and Durable Object configuration. This is code configuration, not evidence that staging has been created or deployed in Cloudflare.
- Read-only HTTPS requests to `https://sinaloa.rachelgonsalves821.workers.dev/health` and `https://sinaloa-staging.rachelgonsalves821.workers.dev/health` both returned Cloudflare HTTP 404. Neither hostname passed an application health check. A 404 alone cannot distinguish an absent deployment from disabled routing or a different live hostname.
- `wrangler whoami` reported **not authenticated**. No connected browser surface was available for a fresh account inspection. Current Workers Paid/Containers entitlement, R2 activation, Builds token permissions, runtime variable/secret inventory, WorkOS, PostgreSQL and scanner state remain unverified in this follow-up.
- The earlier saved variables belong to the Production Worker only. Staging needs its own runtime table, test-only PostgreSQL/R2/scanner resources, and origin-bound WorkOS callback before a staging rollout. Do not copy production secrets or data into staging.

## Applied without deployment

At the dashboard check, the Production runtime table was initially empty. The following eleven plaintext variables were entered and saved using **More options → Save**, not **Add variables and deploy**. The resulting table showed every name/value below. These settings are preparation for a release, not proof that a container is running, and they have not been reverified since the follow-up above.

| Runtime variable | Saved value |
| --- | --- |
| `SINALOA_PUBLIC_URL` | `https://sinaloa.rachelgonsalves821.workers.dev` |
| `SINALOA_CORS_ORIGIN` | `https://sinaloa.rachelgonsalves821.workers.dev` |
| `SINALOA_EDGE_ALLOWED_HOSTS` | `sinaloa.rachelgonsalves821.workers.dev` |
| `WORKOS_REDIRECT_URI` | `https://sinaloa.rachelgonsalves821.workers.dev/api/auth/workos/callback` |
| `SINALOA_DB_SSL_MODE` | `verify-full` |
| `SINALOA_POLICY_ACTIVE_KEY_ID` | `primary` |
| `SINALOA_OBJECT_STORAGE_PROVIDER` | `s3` |
| `SINALOA_S3_REGION` | `auto` |
| `SINALOA_ENABLE_EXTERNAL_EMAIL` | `false` |
| `SINALOA_ENABLE_CALENDAR_WRITES` | `false` |
| `SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS` | `false` |

The actual workers.dev hostname was read from **Domains**. Its switch was disabled/off; no custom domains were present. No domain, route, subscription, credential, access permission, build command, production branch or deployment was changed in this workstream. WorkOS must still register the callback above in the intended provider environment.

The dashboard warns that Wrangler configuration must stay synchronized. The recovery branch now sets `keep_vars: true` and checks it during deployment validation to preserve dashboard-managed variables. Secrets remain encrypted runtime secrets, never source-controlled values.

## Required configuration still missing

“Missing” below means absent from the Production Worker runtime table at the last dashboard check. It does not prove the provider account/resource does not exist elsewhere, nor establish the current state of either Worker's table.

| Name | Cloudflare type | Source / completion requirement |
| --- | --- | --- |
| `DATABASE_URL` | Secret | Managed PostgreSQL connection URL; validate TLS, backups and migrations |
| `WORKOS_CLIENT_ID` | Variable | Intended WorkOS environment |
| `WORKOS_API_KEY` | Secret | Same WorkOS environment; live membership/sign-in acceptance required |
| `WORKOS_COOKIE_PASSWORD` | Secret | Independent strong application session secret, at least 32 characters |
| `SINALOA_DATA_ENCRYPTION_KEY` | Secret | Independent strong encryption key, at least 32 characters; retain securely for existing encrypted data |
| `SINALOA_POLICY_SIGNING_KEY` | Secret | Independent signing key, at least 32 characters, corresponding to `primary`; alternatively use `SINALOA_POLICY_SIGNING_KEYS` JSON keyring |
| `SINALOA_AGENT_DOMAIN` | Variable | Confirm controlled native-address domain; release-plan candidate is `agents.sinaloa-inbox.com`, not yet applied/verified |
| `SINALOA_S3_ENDPOINT` | Variable | Copy the actual endpoint for the intended R2 bucket/account/jurisdiction |
| `SINALOA_S3_BUCKET` | Variable | Private application bucket name |
| `SINALOA_S3_ACCESS_KEY_ID` | Secret | R2 credential restricted to the intended bucket |
| `SINALOA_S3_SECRET_ACCESS_KEY` | Secret | Corresponding restricted R2 credential |
| `SINALOA_MALWARE_SCANNER_URL` | Variable | HTTPS scan endpoint implementing the binary POST contract |
| `SINALOA_MALWARE_SCANNER_TOKEN` | Secret | Scanner service credential if its endpoint requires authentication; recommended for production |
| `SINALOA_BETA_INVITED_EMAILS` | Secret | Exact invited staging human emails; do not include beta invitees without explicit approval |

Optional provider-specific settings: `SINALOA_DB_CA` (secret, if the provider CA is not trusted by the image), `SINALOA_MALWARE_SCANNER_HEALTH_URL` (same-origin HTTPS override; default `/health` must return HTTP 200 JSON `{"ready":true}`), and `SINALOA_S3_SESSION_TOKEN` (secret, only for temporary S3 credentials).

`NODE_ENV`, `SINALOA_AUTH_MODE`, `SINALOA_HUMAN_AUTH_PROVIDER`, `SINALOA_HOST`, `SINALOA_PORT`, `SINALOA_COOKIE_SECURE`, and the trusted-proxy default are supplied by `worker/runtime-config.js`; no duplicate dashboard entries are necessary. Other tuning settings may use validated code defaults for initial staging.

## Provider evidence and blockers

- **R2 is active and direct signed-object operations passed a live smoke test.** A private staging bucket, exact-origin CORS, a bucket-scoped token, and the staging Worker's S3 settings exist. Signed upload, metadata verification, download, invalid-key rejection, and deletion passed outside the deployed Worker after the committed HEAD-length adapter fix. Scanner/quarantine, deployed-Worker, persistence, and recipient-grant acceptance remain open. A separate beta bucket and credentials are needed only after staging acceptance.
- **PostgreSQL and WorkOS staging resources exist, but the app has not exercised them.** Neon staging migrations and the WorkOS staging app are verified in their dashboards. Their secrets and the exact staging invite allowlist are saved on the staging Worker, but the application Container has not consumed them or passed database TLS/sign-in checks. Direct scanner checks passed; combined scanner/R2 quarantine and hosted MFA acceptance remain open.
- **Staging application keys are configured; beta keys are not.** The three generated keys were stored only as encrypted staging Worker secrets. Before storing real user data in beta, arrange durable secure backup and rotation for the beta encryption/signing keys. Never paste credential values into chat or commit them.
- **Workers Paid and Containers entitlement are confirmed in the dashboard.** Wrangler's approved OAuth has `containers:write`; the older GitHub Builds token's `Account > Containers Edit` permission is still not verified. The isolated ClamAV Container rollout succeeded; the application Container rollout remains open.
- **Initial optional integrations stay disabled.** Resend email credentials/domain verification and Google/Microsoft calendar OAuth are not required while their feature flags are false. They require separate provider setup and acceptance before enablement.

## Completion sequence

1. Verify the scanner's scheduled warm-up and cold-start behavior, deploy its committed staging URL with the application, prove combined R2 quarantine, and verify AuthKit MFA is required for the intended WorkOS sign-in methods.
2. Run a secret-safe preflight on the actual staging configuration. Passing preflight validates structure, not credentials or provider operations. Verify the final exact-head CI and fix the Cloudflare branch Preview check separately.
3. Roll out the reviewed Container to `sinaloa-staging`; confirm database TLS, WorkOS MFA onboarding, signed R2 operations, scanner quarantine, restart/revocation and the two-human/two-agent browser journey on the deployed release.
4. After staging acceptance, provision separate beta PostgreSQL/R2/WorkOS and secure beta application keys, apply migrations, verify backup and rollback, bind `beta.sinaloa-inbox.com`, and repeat live acceptance on the exact promoted commit. Keep the old `sinaloa` Worker and its data untouched until that cutover is reviewed.
