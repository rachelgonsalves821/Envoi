# WorkOS Production configuration and owner continuity

Prepared 2026-10-22 in the isolated P0 worktree from integration/agent-native at `244c117fb2a00d6bdc95a991f9021a1fdb94b262`.

The human completed billing and requested Production OAuth configuration with **existing owners and workspaces preserved** and **no deployment**. Production is now unlocked. This branch prepares the non-secret source bindings; it is not ready for integration or activation until the private credential and identity dependencies below are resolved. The served application continues using its existing configuration.

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

The callback, initiate-login and sign-out URLs were saved and read back on the Production application's Redirects page. The logout return deliberately matches `ENVOI_PUBLIC_URL` exactly: `WorkOSAuthService.logout` uses that origin as `returnTo`. Application logout remains the existing CSRF-protected `POST /api/auth/logout`. No wildcard or legacy callback was added. Custom sign-up, invitation and password-reset application URLs remain unset; custom handlers must not be invented where the hosted AuthKit flow is used.

The two supplied client IDs (`client_01M3NESNY6Q9D4BNZR6X724MK6` and `client_01M3PPK3NRG58NWNVKNES9CTRV`) belong to Staging. The former source pin `client_01M3QMT1BN3HEBGE4VPEAQA0GT` belongs to the separately named **Sinaloa Beta test environment**, `environment_01M3QMT0ZAK069BRK0ENNANZAT`. None is a Production client ID. Replacing the client ID alone does not migrate any identity.

Only the selected draft's `wrangler.jsonc` beta client-ID pin and matching assertion in `scripts/check-deployment.mjs` change. Existing callback, app origin, runtime flags, storage and deployment targets remain as before. The derived issuer needs no code change. Privately inspect and remove or replace any existing `WORKOS_ISSUER` override before a later cutover; it must not continue selecting the old client. A new Production API key must be paired with this Production client, not the current test key.

## Account observations and incomplete configuration

At the first read in this session, Production had **no active API keys, no users and no organizations**. This is an actual provisioning dependency, not missing transcription of earlier A/B/C acceptance.

| Setting | Observed state | Remaining action |
| --- | --- | --- |
| Hosted UI | Enabled, WorkOS-managed domain | Use the existing hosted flow; no paid custom domain needed for this preparation |
| Public sign-up | Enabled and retained by the human | Keep sign-up plus Envoi approval; a provider account alone must never grant application/workspace admission |
| Email + Password | Enabled after explicit human approval | Saved and read back: minimum 10 characters, complexity 3; other password settings unchanged |
| Passkeys / Magic Auth | Disabled | Unchanged |
| MFA | Disabled | Privileged-owner/cohort policy must be decided before cutover; no new policy is silently chosen |
| User impersonation | Disabled | Unchanged |
| Social OAuth | All providers disabled in Production; beta has Google/Microsoft/GitHub/Apple enabled with demo credentials | Select the intended launch provider(s), create their real OAuth applications, and have the human enter credentials in WorkOS; demo credentials are not a Production configuration |
| Provider owner accounts | None | Provision verified Production identities for the existing approved owners, not replacement Envoi owners |
| Production key | Active key named Envoi authentication key, bound to the verified default Production application; no recorded use, no expiry | Human confirms it is stored privately; value was not revealed or retrieved. Put it into the protected local preparation file before API validation, without updating a running Worker |

The existing beta email/password policy was read in Sinaloa Beta. No policy change was saved in that environment. The Production single-sign-on method being visible/enabled does not prove an enterprise connection exists or authorize adding one. No paid domain, enterprise connection, invitation or new provider account was created.

The Google provider form was inspected without saving. It requires a real Google Client ID and Google Client Secret and supplies a WorkOS callback URI. That provider-to-WorkOS callback is a separate hop from the WorkOS-to-Envoi callback in the table above. Copy the exact provider callback from the Production form into the selected provider console; do not substitute the Envoi callback. No social scopes or provider-token return setting was changed. A launch-provider choice remains open; social login is not silently added as a requirement for email/password readiness.

Browser credential creation requires human handoff. The API Keys page was left open for Rachel/the human. Keep the new key in the approved private vault; do **not** replace a running Worker secret during preparation. A fresh 64-character random `WORKOS_COOKIE_PASSWORD` was generated locally into the Git-ignored `.env.workos-production-prep`, with ACL access limited to the current Windows user and SYSTEM. Its value was not printed or sent. The file contains the verified non-secret bindings and an empty `WORKOS_API_KEY` slot. The human can enter the privately stored key there; copy the cookie secret into the approved private vault before cutover. This file is not loaded by the ordinary build or running Worker. A public list of secret names is not evidence that their values are present or correct. Keep application encryption, policy signing, database and agent credentials unchanged.

## Preserve existing owners and workspaces

The preservation policy is explicitly selected by the human. An empty/new application tenant or email-only automatic linking is not an alternative authorized by this task.

Current code uses these bindings:

- `humans/<humanId>.json`: existing local `id`, `workosUserId`, verification/profile fields.
- `auth/workos-user-index/<providerUserId>.json`: provider ID to existing `humanId`.
- `organizations/<organizationId>/organization.json`: existing local ID, `ownerHumanId`, `workosOrganizationId`.
- `auth/workos-organization-index/<providerOrgId>.json`: provider organization to local organization ID.
- `organizations/<organizationId>/members/<humanId>.json` and `humans/<humanId>/organizations/<organizationId>.json`: existing local memberships and organization references.

`WorkOSAuthService.upsertHuman` resolves the provider-user index and otherwise creates a new local human. `getAuthorizedMembership` also checks a live provider membership using the organization's stored provider ID. Therefore an uncoordinated switch can create a second local human, fail workspace authorization, and then make the default-workspace path create a second workspace. The draft must not be activated before the following is implemented and verified:

1. Read the intended **beta application database**, verify its deployment stamp, and privately inventory every affected local human, provider-user index, organization, provider-org index, membership, owner reference, inbox/agent ownership and case history. Preserve an independently verified recovery point. No usable database binding or inventory was available in this session.
2. Provision/verify the corresponding Production provider users and organizations, with explicit stable external IDs where appropriate. Do not copy passwords, staging cookies, sessions or API keys. Confirm the exact old/new provider IDs against the existing local IDs with the account operator. A shared email address is only supporting verification, never the mapping authority.
3. Recreate active provider memberships with the existing effective roles; do not increase permissions or reactivate removed members. Preserve local human/organization IDs, `ownerHumanId`, memberships, organization references, inboxes, agents, credentials, messages, cases, assets and audit history.
4. Implement one bounded, idempotent, transactional mapping of the selected provider ID fields and lookup indexes. Require exact expected old values, complete mapping coverage and collision checks; repeated application must be a verified no-op. Capture original values and a manifest digest privately. Neither a blanket `upsertHuman` email fallback nor a runtime auto-migration is acceptable.
5. Test the mapping and its inverse on an isolated restored database before any live mutation. Verify both existing owners resolve to the same local IDs and workspaces; roles, agent/case history and cross-tenant isolation remain intact. Reject a conflicting/already-bound target identity and incomplete inventories. Rollback must refuse overwriting unrelated later edits.
6. Only during a separately approved maintenance/cutover window, coordinate the verified mapping, matched Production API key/client/issuer, new cookie-sealing secret, paired Worker/container release and fresh owner reauthentication. Do not change the live key/client pair separately while the old app is serving. Keep the previous matched auth/release pair and recovery material for rollback.

No mapping implementation or execution is claimed by this configuration-only draft: the actual private inventory and Production target identities are missing. No local or hosted owner/workspace record has been changed. This is a concrete cutover dependency, not a request to repeat previously accepted core agent-runtime gates.

## Verification and release boundary

Completed locally from PowerShell: deployment configuration check; focused WorkOS authentication/session, production configuration and release-target checks, 50/50; full build/typecheck with unchanged generated files; frontend 432/432; TypeScript SDK 548/548; integrations 896 passed and 1 existing skip; Python SDK 6/6; serial backend 661 passed, 37 existing environment skips, zero failures; scanner 14/14; stress PASS; Cloudflare configuration/Worker tests and staging/beta/scanner dry-runs PASS; full npm audit zero vulnerabilities. PostgreSQL/container and exact draft-PR CI remain pending publication approval and cannot be borrowed from #199 or these local checks.

Full Production sign-in, admission, callback replay/CSRF, owner continuity, refresh, logout and inverse/paired rollback acceptance remain unrun. Testing new Production credentials against an undeployed old app would not validate this draft. No merge, deployment, running Worker secret update, hosted test or invitation is authorized by this preparation. Both remote-agent OAuth/provider flags and Stage A stay as before; WorkOS browser login is a separate integration from the pending agent remote-auth server stack.

The earlier consolidated candidate at #199/244c117 and accepted Phase A/B/C evidence remain credited for their original scope. This record updates only the formerly deferred WorkOS billing/unlock and the newly inspected Production configuration.

## Publication boundary

Automatic approval review rejected publishing the account-specific identifiers and operational status to GitHub because the exact external disclosure was not specifically approved. Keep this review packet and source changes local until the human approves publishing these non-secret values to the Envoi repository/build board. No key, private owner identity or database connection string is included. Automatic review separately rejected saving the public-sign-up policy; that form was cancelled. The human then explicitly chose to retain sign-up with Envoi approval, so public sign-up remains enabled and no disable action is pending. The human explicitly approved Email + Password with the beta policy; that approved setting was saved and verified. No workaround or indirect retry is authorized.

Public health checks after local validation still report beta 1c4176b3a2587369a1a82e709598091e275177b8 and staging 2b18170d59b0096ff997d9a79487d50ccb627ef9, both configurationValidated true. These are the previous served releases, not tests of this draft.
