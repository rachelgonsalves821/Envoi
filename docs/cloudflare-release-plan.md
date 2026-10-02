# Cloudflare beta release plan

Updated 2026-09-29 after PR #6 merged into `main` at `fc2e1d8b72280789e365e9f8b8e399717933ccb6`. The current procedure is the [closed-beta launch runbook](closed-beta-launch-runbook.md). The [runtime inventory](runtime-configuration-status.md) records dated provider observations; neither a merged implementation nor earlier staging readiness proves the current candidate passed live acceptance.

## Release targets

| Environment | Application Worker / Container | Public application origin | Promotion command |
| --- | --- | --- | --- |
| Staging | `sinaloa-staging` / `sinaloa-beta-staging` | `https://sinaloa-staging.rachelgonsalves821.workers.dev` | `node scripts/promote-release.mjs staging <FULL_SHA> --deploy` |
| Invite-only beta | `sinaloa-beta` / `sinaloa-beta-release` | `https://www.envoi-agents.com` | `node scripts/promote-release.mjs beta <FULL_SHA> --deploy` |

Record and deploy one reviewed candidate SHA to staging, accept its hosted journey, then promote the same SHA to beta. Rachel executes hosted commands from her authenticated account. Run the guarded promotion helper without --deploy first; live promotion requires clean HEAD equal to the supplied full SHA and fetched origin/main, pins the intended account and records SINALOA_RELEASE_SHA. A descendant candidate can be dry-run before merge. Smoke checks both health/readiness release identities against that SHA. Staging Builds has historically tracked `codex/staging-readiness`, so a `main` merge does not prove staging has updated. Use an explicit deployment from the recorded candidate and record Worker version and Container image digest. Keep the old `sinaloa` Worker disconnected from Git Builds. The unqualified `npm run cf:deploy` deliberately fails; bare `wrangler deploy` targets the old Worker and is not a release command.

The beta Worker admits `www.envoi-agents.com` and temporarily retains `beta.sinaloa-inbox.com`, disables its `workers.dev` endpoint and uses custom-domain routes in `wrangler.jsonc`. Deployment binds the new custom domain while preserving the old one until redirects work. Finish beta secret entry, callback/CORS configuration, authenticated scanner proof, database migration and backup prerequisites before this exposure. Run new-domain application smoke only after its binding exists and DNS resolves. Do not test the beta app through a workers.dev hostname or use the old domain as the new release target.

## Resource and policy gates

Workers Paid, effective Containers/Worker deployment permissions, isolated TLS PostgreSQL, a private bucket with restricted credentials, authenticated HTTPS scanner and separate WorkOS application/environment must be verified for each target. Workers Builds tokens require effective Containers deployment access; store build credentials in Cloudflare build settings and application credentials in encrypted runtime secrets.

The runbook lists the nine beta-only app secret names. Cookie, data-encryption and policy-signing keys are independent new beta keys; the scanner bearer matches the beta scanner's encrypted `SINALOA_SCANNER_TOKEN`. Verify secret names and behavior without printing values. Keep staging, beta and old production credentials/data separate. Never assume dashboard entries have been consumed successfully by the Container.

The approved beta is invite-only with WorkOS MFA Off and self-service signup disabled. Hosted sessions carry provider assurance; email verification, exact-email admission and current organization management authority remain mandatory. Twilio and a separate application SMS/TOTP challenge are not beta prerequisites. External email, calendar writes and consequential actions stay disabled.

## Acceptance and recovery

The runbook requires exact-candidate CI and packaging checks, provider proofs, two humans and real OpenClaw/xAI hosted MCP calls, two shared cases, file safety, negative authorization, bounded single-Container load, restart, alerts, populated-data restore and schema-compatible application rollback. `/ready` verifies dependency reads/health, not this complete acceptance matrix. No skipped live test counts as evidence of a pass.

Back up before migration; validate the migration ledger against immutable Git LF bytes and never edit applied SQL or silently repair checksums. Preserve database schema, business data, retained encryption/signing keys, queue/scan records and R2 objects during application rollback. Record the previous version and compatible migration set before deployment. Run recovery on isolated restored data before signoff.

The beta R2 credential is recorded as expiring **2026-10-29**. Its rotation owner and reminder are pending; assign both and prove replacement credentials before inviting the cohort. This document creates no reminder or provider change.
