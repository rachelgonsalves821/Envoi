# WorkOS Production configuration and owner continuity

Prepared 2026-10-22 in the isolated P0 worktree from integration/agent-native at `244c117fb2a00d6bdc95a991f9021a1fdb94b262`.

The human completed billing and requested Production OAuth configuration with **existing owners and workspaces preserved** and **no deployment**. The saved provider configuration, approved Production records, private mapping and read-only preflight are prepared. This draft adds the operator-invoked transactional mapping and inverse. It is not authorization to integrate, activate or deploy. An independently verified recovery point, restored-database rehearsal and coordinated cutover remain required.

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

## Remaining cutover sequence

1. Preserve an independently verified recovery point of the intended beta database and a private copy of the exact provider plan, receipt and complete mapping. Restore the recovery point to an isolated database. Rebind a rehearsal manifest explicitly to that isolated target, then test forward, repeated application and inverse with existing owners, workspace references and history. Synthetic CI transactions do not replace this restored-data rehearsal.
2. Have the existing owners complete Production verification/password setup themselves. Re-read the exact Production users, organizations and active memberships and confirm the same stable external IDs. Check private admission allowlist continuity. No invitations or password changes are implied by this draft.
3. Obtain human approval for the exact candidate, migration digest, recovery material and maintenance/cutover window. Integration and deployment are separate actions. Stop old writers before applying the mapping; the module's table lock is not a substitute for quiescing the old application.
4. In the approved window, refresh the complete inventory if anything changed, review the new digest, apply once and verify a repeated no-op. Coordinate the matched Production key/client/issuer, new cookie secret and paired Worker/container release. Owners must freshly authenticate. Do not switch a running key/client pair independently.
5. Validate fresh sign-in, retained approval admission, owner/workspace IDs and roles, cross-tenant isolation, callback replay/CSRF, refresh and logout on the deployed candidate. Preserve the previous matched auth/release pair and tested recovery material. Rollback requires quiescing writers and a verified inverse; reconcile later identity edits instead of forcing the inverse.

No live application database mutation, running Worker secret update, hosted sign-in test, merge or deployment has occurred. Social login remains explicitly deferred. Earlier accepted Phase A/B/C evidence remains credited for its original scope; this work does not reopen those gates. Both remote-agent OAuth/provider flags and Stage A remain unchanged; WorkOS browser login is separate from the agent remote-auth stack.

## Verification and publication

Exact source checks and CI links are recorded in draft PR #205 and build-board issue #34, including the new migration/inverse checks. Earlier configuration-only CI at `8d732ca` was fully green; it is not borrowed for a later source head. Generated bundles must remain equal to a fresh build.

The human explicitly approved publishing non-secret WorkOS client/environment/application IDs, saved URL/policy status, source pins and test results to the draft PR and #34. Private keys, owner identities, database connections, inventory, mapping, receipts and screenshots are excluded. The human separately approved the exact Production provisioning records. Neither approval authorizes a deployment or live database cutover.
