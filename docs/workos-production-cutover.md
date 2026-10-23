# WorkOS Production configuration and owner continuity

Prepared 2026-10-22 in the isolated P0 worktree from integration/agent-native at `244c117fb2a00d6bdc95a991f9021a1fdb94b262`.

The human completed billing and requested Production OAuth configuration with **existing owners and workspaces preserved** and **no deployment**. The saved provider configuration, approved Production records, private mapping and read-only preflight are prepared. This draft adds the operator-invoked transactional mapping and inverse. It is not authorization to integrate, activate or deploy. The restored-data rehearsal and read-only preservation checks are recorded privately and on build-board #34. A fresh recovery point at the quiesced cutover boundary and the approved coordinated release remain required.

## Verified Production binding

| Item | Dashboard value |
| --- | --- |
| Project | Sinaloa's Project |
| Environment | Production: `environment_01M3NESPE6SRGN6GVCVMGQFCFV` |
| Application | Default `gmail.com's Application`: `app_01M3NESPPADMS392VNS4MR58F9` |
| Client ID | `client_01M3NESPM075W2JNEB3N7FRVZF` |
| Application origin | `https://www.envoi-agents.com` |
| Exact default callback | `https://www.envoi-agents.com/api/auth/workos/callback` |
| Initiate login | `https://www.envoi-agents.com/api/auth/workos/sign-in` |
| Default sign-out return | `https://www.envoi-agents.com` |
| Derived issuer | `https://api.workos.com/user_management/client_01M3NESPM075W2JNEB3N7FRVZF` |

The three URLs were saved and read back on the Production application's Redirects page. The logout return matches `ENVOI_PUBLIC_URL`: `WorkOSAuthService.logout` uses that origin as `returnTo`. Application logout remains the CSRF-protected `POST /api/auth/logout`. No wildcard or legacy callback was added. Custom sign-up, invitation and password-reset application URLs remain unset; the hosted AuthKit flow is used.

The supplied clients `client_01M3NESNY6Q9D4BNZR6X724MK6` and `client_01M3PPK3NRG58NWNVKNES9CTRV` belong to Staging. The previous source pin `client_01M3QMT1BN3HEBGE4VPEAQA0GT` belongs to the **Sinaloa Beta test environment**, `environment_01M3QMT0ZAK069BRK0ENNANZAT`. Replacing a client ID alone does not migrate identities.

The draft changes the beta client-ID pin in `wrangler.jsonc` and its assertion in `scripts/check-deployment.mjs`. The issuer derives from the client. Before cutover, privately remove or replace any `WORKOS_ISSUER` override selecting the old client. Pair the new client with the new Production API key; do not update the running key/client separately. Runtime flags, app URLs and deployment targets remain unchanged.

## Saved settings and approved provisioning

| Setting | Verified state |
| --- | --- |
| Production access | Unlocked after the human completed billing |
| Hosted UI | Enabled, WorkOS-managed domain; no custom domain added |
| Public sign-up | Enabled and explicitly retained with Envoi approval |
| Application admission | Verified provider email plus existing exact approved-email allowlist; provider registration alone grants no workspace access |
| Email + Password | Enabled after explicit approval: minimum 10 characters, complexity 3 |
| Social login | Disabled; the human explicitly selected Email + Password first and social login later |
| Passkeys, Magic Auth, MFA, impersonation | Unchanged; no additional policy inferred |
| Production key | Human-created Envoi authentication key, stored privately and successfully API-validated |
| Provider identities | Exactly two approved users and two organizations created and read back, using the existing local IDs as external IDs |
| Provider memberships | Exactly two active Admin memberships created and read back, matching the source provider roles |

The source provider memberships were verified against the selected existing owners and workspaces; unrelated historical/test organizations were excluded. Provider users were created with `emailVerified: false` and no password/hash. No invitation, password-reset or verification-email API was called. The owners must complete their own Production verification/password setup through the approved hosted flow; old passwords, verification claims and sessions are not copied.

The protected Git-ignored `.env.workos-production-prep` holds the human-supplied API key and database URL plus a freshly generated cookie-sealing secret. Access is limited to the current Windows user and SYSTEM. It is not loaded by an ordinary build or running Worker. Private inventory, provisioning receipt, mapping and validation files use the same protection. Values, private identities and database connection details must not enter Git, CI, screenshots published to GitHub or issue comments. Keep the cookie secret in the approved private vault before cutover; other application encryption, signing and agent credentials remain unchanged.

## Inventory and continuity model

The intended beta database was inventoried using verified TLS and a read-only transaction. The served legacy release `1c4176b3a2587369a1a82e709598091e275177b8` has no database-stamping implementation, explaining its absent stamp. The one-off inventory pins that audited legacy release and exact verified database target; it does not relax runtime startup guards or write a stamp. A present stamp naming another deployment is always refused.

The minimal first inventory omitted `verifiedAt` and workspace `slug`. The strict mapping dry-run detected the difference and refused. A second private inventory retained complete identity documents and verified every previously captured field against the first inventory and approved owners. The resulting mapping passed a fresh read-only preflight against the actual database with zero writes. Neither inventory is a full recovery backup.

Existing bindings:

- `humans/<humanId>.json`: stable local ID and provider `workosUserId`.
- `auth/workos-user-index/<providerUserId>.json`: provider to existing local human.
- `organizations/<organizationId>/organization.json`: stable local ID, owner and provider `workosOrganizationId`.
- `auth/workos-organization-index/<providerOrgId>.json`: provider to existing local organization.
- Local member documents and human-to-organization references remain unchanged.

`WorkOSAuthService.upsertHuman` resolves the provider-user index; an unmatched provider ID creates a new human. Organization access also checks current provider membership. An uncoordinated switch can duplicate local owners/workspaces or deny existing access. The explicit mapping is required before activating this configuration.

## Transactional mapping and inverse

`scripts/workos-identity-mapping.mjs` is an offline preparation and maintenance module, never imported or automatically executed by the server. It exposes:

- `prepareWorkosIdentityMapping(input)`: complete private identity documents, explicit old/new user and organization IDs, database fingerprint, deployment binding and source inventory digest produce a digest-bound manifest.
- `validateWorkosIdentityMapping(manifest)`: verify the digest and independently regenerate the allowed transform, refusing arbitrary extra writes even if the manifest was rehashed.
- `executeWorkosIdentityMapping(connectedPgClient, manifest, options)`: a dedicated `pg.Client`; read-only dry-run by default. Forward or inverse writes require `dryRun: false`, the exact `approvedDigest`, `maintenanceConfirmed: true` and a nonempty `recoveryReference`. These arguments are operator safeguards, not substitutes for human authorization.

The implementation is deliberately limited to the reviewed owner-only cohort. It requires complete coverage, active local owner memberships, unchanged owner references, unique old/new IDs, exact old provider values, correct source indexes and absent target indexes. It never discovers mappings from email. Added users, organizations, members or indexes require an updated reviewed inventory rather than silent omission.

Execution verifies the connected database fingerprint and database name, then checks deployment identity. An absent stamp requires the explicit audited legacy release pin. It runs in one SERIALIZABLE transaction; writes hold a table lock to prevent concurrent identity insertions or edits. Forward application updates only provider ID fields and their indexes. Local IDs, profile/history fields, local roles, owner references and every other document remain intact. A repeated application is a verified no-op. No stamp or runtime schema migration is performed.

The inverse uses the same private manifest and full expected post-migration snapshot. It refuses unrelated later profile/membership changes or new identities instead of overwriting them. SQL failures roll back all mapping writes. If COMMIT loses its response, the outcome is explicitly unknown: reconnect and run the default read-only check before any retry. Do not infer success or failure from a disconnected session.

Tests include complete-field preservation, missing/duplicate/conflicting mappings, digest tampering, actual auth upsert preserving local humans, explicit write safeguards, and isolated PostgreSQL transactions. PostgreSQL tests exercise no-write dry-run, partial inventory refusal, mid-transaction failure, idempotent forward/inverse, later-edit refusal, deployment mismatch and unchanged inbox/agent/case ownership. The PostgreSQL cases run in `npm run test:postgres` on the CI loopback database, never the private hosted database.

## Encrypted binding preparation

The beta release guard requires canonical names for the app policy-signing key, S3 access key ID/secret and malware-scanner token, plus the scanner's own token. Where the existing encrypted values have only legacy names, retain those bindings and add these canonical aliases:

| Existing encrypted name | Canonical name |
| --- | --- |
| SINALOA_POLICY_SIGNING_KEY | ENVOI_POLICY_SIGNING_KEY |
| SINALOA_S3_ACCESS_KEY_ID | ENVOI_S3_ACCESS_KEY_ID |
| SINALOA_S3_SECRET_ACCESS_KEY | ENVOI_S3_SECRET_ACCESS_KEY |
| SINALOA_MALWARE_SCANNER_TOKEN | ENVOI_MALWARE_SCANNER_TOKEN |
| SINALOA_SCANNER_TOKEN (scanner Worker) | ENVOI_SCANNER_TOKEN |

Cloudflare's Worker Versions API supports inherited bindings with an explicit source version and old_name. Validation uses the locally built repository bundles and deploy=false, retaining every original binding and adding the aliases without reading or replacing plaintext values. Do not use a deployed-code download or silently inherit from an unverified latest version. See [Create Worker Version](https://developers.cloudflare.com/api/python/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/).

Undeployed versions store pending migrations separately from an applied migration tag. Preserve the existing Durable Object/container attachment and use identical old/new migration tags with no migration steps; verify that the active version and applied tag have not changed. These validation versions retain the existing beta authentication bindings and are not the Production cutover release. Their creation does not authorize activation.

Re-read the actual app and scanner secret inventories through requireBetaSecretNames before cutover. Preserve the existing data-encryption material, policy key ID, storage/scanner values and admission allowlist. Do not rotate keys just to obtain new names. Validate unchanged active deployments, traffic, cron schedules, routes/settings and absence of version URLs. Container Workers do not generate version URLs; [Cloudflare documents the limitation](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/#limitations).

## Remaining cutover sequence

1. Finish the reconciled candidate, exact-head CI, encrypted-binding validation and read-only owner/membership checks. Keep the completed restored-data forward/no-op/inverse rehearsal and exact mapping digest with the private evidence. An identity inventory is not a recovery backup. Re-read the two Production users, organizations and active memberships; preserve the existing local IDs and exact admission allowlist.
2. Obtain human approval for the exact candidate, mapping digest, rollback references and maintenance/cutover window. The release candidate must contain fetched main, and live promotion requires HEAD to equal fetched origin/main. Integration and deployment are separate approvals. Pause automatic beta Builds before any approved main update so the Production client cannot activate with the old API key.
3. In the approved window, fence both application hosts and pause warm-up schedules. Positively verify old instances and background writers have stopped; a traffic fence, operator flag or mapping table lock does not prove quiescence. Create and retain a fresh recovery point at that boundary and verify the agreed restored-data proof. If identity documents drift, refresh and review the manifest digest rather than bypassing its exact preconditions.
4. Apply the approved mapping once and verify a repeated no-op. Use a reviewed, guarded deployment invocation to pair the Production key/client/issuer and prepared cookie secret with the exact Worker/container release. The WorkOS key and cookie can be supplied privately with Wrangler's secrets-file option in that same code upload; omitted existing secrets must be retained. The ordinary deployment helper does not automatically load the private Production preparation file. Keep the existing encryption/signing/storage/scanner values and allowlist intact. Worker activation and Container image rollout are separate operations; keep traffic held until both finish and exact release/image identity is verified.
5. **Only after the routing switch**, admit the approved owners for authentication acceptance. Each owner starts a fresh flow from the normal Envoi sign-in endpoint, confirms positive-element-88.authkit.app, chooses **Reset password**, and privately opens the newest reset email in that browser. Each sets their own password and completes any remaining verification. Confirm Production reset-success events, verified email flags and original Envoi human/workspace/inbox IDs and roles. Do not use old direct setup links or repeat resets while the live initiate-login endpoint still selects beta.
6. Verify callback replay/CSRF, session refresh/logout, retained signup/approval admission and cross-tenant denial. Include a controlled storage/scanner compatibility check: inherited encrypted metadata proves preservation, not a live end-to-end scan. Restore normal traffic and schedules only after acceptance, then deliberately restore the agreed Builds policy. A failed check keeps traffic held.

Preserve the previous matched auth/release pair and immutable container image. Rollback requires stopping writers, checking the inverse preconditions and restoring matching provider references, Worker bindings and image. The inverse refuses later identity edits; reconcile those edits instead of forcing it. The staged binding-validation versions are not substitutes for the matched prior release.

No live application database mutation, running authentication switch, hosted Production sign-in acceptance, merge to main or deployment is authorized by this preparation. Social login remains explicitly deferred. Earlier accepted Phase A/B/C evidence remains credited for its original scope; this work does not reopen those gates. Both remote-agent OAuth/provider flags and Stage A remain unchanged; WorkOS browser login is separate from the agent remote-auth stack.

## Verification and publication

The original mapping implementation is integrated from PR #205. Draft PR #208 reconciles current main into that P0 baseline and corrects the operational sequence; its exact source checks and CI links are recorded there and on build-board issue #34. Earlier configuration-only CI at `8d732ca` was fully green; it is not borrowed for a later source head. Generated bundles must remain equal to a fresh build.

The human explicitly approved publishing non-secret WorkOS client/environment/application IDs, saved URL/policy status, source pins and test results to the draft PR and #34. Private keys, owner identities, database connections, inventory, mapping, receipts and screenshots are excluded. The human separately approved the exact Production provisioning records. Neither approval authorizes a deployment or live database cutover.
