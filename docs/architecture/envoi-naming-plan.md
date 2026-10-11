# Envoi naming plan

**Prepared:** 2026-10-09 by Lane A (Claude), audited against `integration/agent-native` @ `0b6e6a8`. **Decision owner:** the human (pjsk02).

**Status:** decided 2026-10-09 (see §0). This document changes no code; each phase lands through its own reviewed PRs.

## 0. Decisions (human, 2026-10-09)

1. **Rename everything, properly:** N1, N2 and N3.
2. **N1 lands before H-5.**
3. **No beta testers are on the system yet,** so there are no installed connectors, SDK users or live sessions to protect. Every rename is therefore a **clean cutover**:
   - both sides change in the same integration SHA, as the health identity did (PRs #46 and #48);
   - there are no deprecated `sinaloa_*` aliases and no alias window;
   - the one exception is data already stored in staging or beta. Stored credentials, cookies, R2 object metadata, database tables and Cloudflare resources are migrated or reissued, not aliased.
4. **The environment should be ready before beta testers arrive.**

**Further decisions (human, 2026-10-10)**

5. **Object-storage metadata moves to N3.** That covers `x-amz-meta-sinaloa-*` and the tombstone content type on stored R2/S3 objects, plus the `x-sinaloa-*` headers the server sends the scanner Worker. N3 already renames the scanner Workers and buckets, so all of it moves in one coordinated deploy, with nothing aliased in between.
6. **Monitoring events wait on a human check.** Nobody knows yet whether an alert rule, log filter or dashboard matches `sinaloa.operational_backlog`. The human checks and updates any such rule first, then Lane A renames the events.
7. **Config aliases are removed in N2.** Lane A renames the `wrangler.jsonc` vars and Worker forwarding, and posts an exact dashboard checklist. The human adds the `ENVOI_*` secrets on staging, beta and the scanners. The `SINALOA_*` aliases come out only after the human confirms.

**Status (2026-10-10).** N1 is done: `envoi-names` v1 is integrated at `1766767`. The N2 browser names are contract `envoi-names` v2 (published). The rest of N2 is the task list in §4.

The product is **Envoi**. "Sinaloa" was the working name. The goal is that Envoi is the only name people, agents, SDK users and operators see.

## 1. What is already done

All three of Rachel's Envoi PRs are merged. No other branch or PR, pushed or local, contains further rename work.

| PR | Done |
| --- | --- |
| #13 | Beta hosting and auth URLs moved to `envoi-agents.com`. |
| #26 | The app UI says Envoi. |
| #33 | Backend reads `ENVOI_*` config names and still accepts `SINALOA_*` values when they agree. User-visible labels say Envoi: logs, the MCP server display name, the npm package `envoi`, and `/health` `service`. `docs/envoi-backend-rename-inventory.md` lists everything left. |

One gap from #33 is being closed now. Shipped connectors only start when `/health` says `sinaloa`, so the server label alone broke connector startup (GA3, and live on beta). PR #46 together with a Lane B connector change move both sides to `envoi` on one integration SHA.

## 2. What still says Sinaloa

| Group | Where | Seen by | Why it can't be a search-and-replace |
| --- | --- | --- | --- |
| MCP tool names | 19 tools in `src/agent-mcp.js` (`sinaloa_start_case`, `sinaloa_claim_work`, …) | Agent models, and every runtime prompt or adapter | Running agents and their prompts call these names. |
| Credential token prefixes | `sinaloa_agent_access_`, `sinaloa_agent_refresh_`, `sinaloa_mcp_read_` | Agent operators, logs, secret scanners | Existing credentials carry the old prefix, and the server checks prefixes. |
| SDKs | `@sinaloa/protocol` (TypeScript) with `SinaloaClient`, `SinaloaConnector`, `SinaloaError`, `SinaloaIntent`; `sinaloa-protocol` / `sinaloa_protocol` (Python) | Developers | Published package and import names. Code that imports them breaks on rename. |
| Connector | 199 strings and identifiers in `integrations/**` and the SDKs (`checkSinaloa`, messages); `web/downloads/sinaloa-connector.mjs` and `sinaloa-openclaw.mjs` next to the `envoi-*` files | Agent operators | Installed connectors, saved state paths and old download links. |
| HTTP names | Headers `x-sinaloa-csrf` (browser); `x-sinaloa-object-id`, `x-sinaloa-sha`, `x-sinaloa-tombstone` (object storage); protocol schema `$id` under `sinaloa.mail` | Browser and frontend; stored R2 object metadata | Browsers and stored objects carry the old names. |
| Cookies | `sinaloa_session`, `sinaloa_csrf` | Browsers | Renaming signs every user out unless both names are read during a transition. |
| Monitoring events | `sinaloa.operational_backlog`, `sinaloa.operational_backlog_error` | Alerts and dashboards | External alert rules match these names. |
| Config names | `SINALOA_*` dashboard keys (aliases exist) | Operators | Values must be copied safely in the dashboards first. |
| Database | `sinaloa_*` tables, indexes and the migration ledger | No one outside operations | It needs a migration with a tested restore. |
| Cloudflare and Neon | Workers `sinaloa`, `sinaloa-staging`, `sinaloa-beta`, `sinaloa-beta-release`, scanner and ClamAV containers, the `SinaloaContainer` Durable Object class and binding, R2 buckets, Neon projects and databases | Operators only | These identify deployed resources and state. Renames are infrastructure migrations, and the dashboard parts are human-only. |
| Docs | 34 docs and the README mention Sinaloa | Readers | Current docs should say Envoi; dated records stay accurate. |
| Local folder | `D:\vsc\NEU\Sinaloa` | Only you | Renaming it breaks the agents' worktree paths, so do it between work sessions. |

## 3. Approach

Every rename follows the same pattern, unless both sides ship together in one release:

1. **Add the Envoi name.**
2. **Accept both names.**
3. **Move every producer and consumer to Envoi.**
4. **Remove the Sinaloa name** after an announced window.

Each agent-facing step lands the way the build already works:
- Lane A publishes a contract with fixtures;
- Lane B updates clients;
- the human approves.

**Key timing point.** A1 already forces every beta connector to be replaced at the coordinated connector release (H-5), because old binaries lack the mandatory `rotationId`. Doing the agent-facing renames **before H-5** means beta users upgrade once and get an all-Envoi connector, instead of upgrading again later.

## 4. Phases

### N1. Agent-facing names (done)

**Done** as a clean cutover with no aliases: contract `envoi-names` v1, integrated at `1766767` (2026-10-10). The alias and removal-window text below is the pre-decision draft, kept for the record; `handoffs.md` `envoi-names v1` is authoritative.

**Owners:** Lane A for the server and contract, Lane B for clients.

One contract, `envoi-names v1`, with fixtures, covering:

- **Health identity.** Both sides move to `envoi` (PR #46 plus the Lane B change). Already in progress.
- **MCP tool names.**
  - The server lists `envoi_*` tools: `envoi_start_case`, `envoi_claim_work`, and so on.
  - It still accepts calls to the `sinaloa_*` names as unlisted, deprecated aliases until N1 removal.
  - Hermes, OpenClaw and xAI adapters and setup prompts use only `envoi_*`.
- **Token prefixes.**
  - New credentials are issued as `envoi_agent_access_…`, `envoi_agent_refresh_…` and `envoi_mcp_read_…`.
  - The server accepts both prefixes, because credentials are stored hashed and the prefix is only a format check.
  - Existing tokens roll over to the new prefix at their next refresh, so they all change within the 30-day inactivity window. After that the old prefix is refused.
  - The `a3-pause-auth` fixtures gain `envoi_` examples.
- **SDKs.**
  - TypeScript: publish `@envoi/protocol` with `EnvoiClient`, `EnvoiConnector`, `EnvoiError` and `EnvoiIntent`. The old names stay as deprecated re-exports.
  - Python: publish `envoi-protocol` / `envoi_protocol`, plus a thin `sinaloa_protocol` shim that warns and re-exports.
- **Connector.**
  - Rename internal identifiers and every user-visible string.
  - Ship only `envoi-*.mjs` downloads, and remove the `sinaloa-*.mjs` duplicates at H-5.
  - Move saved state to an Envoi path, migrating the old path automatically on first start.
- **Protocol schema `$id`.** Moves to an `envoi-agents.com` URL. The old `$id` is accepted for validation.

**Gate:** a fresh real Hermes and OpenClaw run on staging shows only Envoi names to the model and the operator. This rides on the Phase A hosted gate (GA) already planned.

**Removal:** the `sinaloa_*` tool aliases, the old token prefix and the SDK shims are removed in a later release, at least 30 days after H-5. Users are told the date.

### N2. Browser and operator names (after N1)

**Owner:** Lane A, plus the human for dashboards and alerts.

*Superseded by the clean-cutover decision (§0, items 3 and 5–7).* Each item is a clean cutover. The tasks, in order:

| Task | Owner | What | Gate |
| --- | --- | --- | --- |
| **N2-contract** | Lane A | Contract `envoi-names` v2: cookies `envoi_session`, `envoi_csrf` and `envoi_workos_flow`; CSRF header `x-envoi-csrf`; old cookies cleared, never read. It also defines name-only bumps `a3-pause-auth` v3 and `a4-wake` v2. | Lane B ACK, then human approval |
| **N2-server** | Lane A | Server, CORS and the regenerated a3 v3 / a4 v2 fixtures. | Integrated **together with N2-client on one SHA**. Everyone signed in re-signs once. |
| **N2-client** | Lane B | `frontend/src/api.ts` sends `x-envoi-csrf` and falls back to `envoi_csrf`; rebuild `web/**`. | Same SHA as N2-server |
| **N2-events-check** | Human | Check for alert rules, log filters or dashboards matching `sinaloa.operational_backlog` or `sinaloa.operational_backlog_error`, update them to `envoi.*`, and confirm on the build board. | Before N2-events |
| **N2-events** | Lane A | Emit `envoi.operational_backlog` and `envoi.operational_backlog_error` only. | After N2-events-check |
| **N2-config-1** | Lane A | Rename every `SINALOA_*` var in `wrangler.jsonc` to `ENVOI_*`, plus the Worker forwarding and the deployment checks. Post the exact dashboard checklist (secret names only, never values). Safe on its own: the server already prefers `ENVOI_*` and still accepts agreeing `SINALOA_*` values. | — |
| **N2-config-dashboards** | Human | Add the `ENVOI_*` secrets on staging, then beta, then both scanner Workers, per the checklist. Confirm `/ready`, sign-in, the database, R2 and the scanner after each. | Before N2-config-2 |
| **N2-config-2** | Lane A | Remove the `SINALOA_*` alias layer (`src/envoi-environment.js`, Worker and scanner fallbacks). Production validation then refuses a `SINALOA_*` key. | After the human confirms staging and beta |
| **N2-docs** | Lane A | Current operator docs and the README say Envoi. Dated evidence stays as written. | — |

### N3. Infrastructure identities (decided: yes; invisible to users)

**Owner:** the human, with a Lane A runbook and rollback.

These names are never seen by customers or agents. The human chose to rename them too (§0, item 1). Each needs a migration with a tested rollback:

- **Database.** One migration renames `sinaloa_*` tables and indexes to `envoi_*` in a single transaction, with a restore drill first. Code switches table names in the same release.
- **Cloudflare.**
  - Create `envoi-staging`, `envoi-beta` and `envoi-scanner-*` Workers.
  - Migrate the Durable Object class with a Wrangler `renamed_classes` migration.
  - Copy R2 buckets.
  - Move the custom domain.
  - Retire the old Workers after a rollback window.
  - Builds settings move to the new Worker. That is a repeat of H-2.
- **Object storage and scanner (moved here 2026-10-10).** The stored metadata `x-amz-meta-sinaloa-sha256` and `x-amz-meta-sinaloa-tombstone`, the `application/x-sinaloa-tombstone` content type, and the server-to-scanner headers `x-sinaloa-object-id` and `x-sinaloa-sha256`. They move with the bucket copy and the new scanner Workers, so no stored object carries a name the code no longer reads.
- **Internal identifiers.** The development-only key fallbacks `sinaloa-development-only` and `sinaloa-development-policy-signing-key`. Renaming them makes local data encrypted under the old fallback unreadable, and the production validator must refuse both old and new values. Also the default policy id `sinaloa-default-authority` (policy decisions in flight at the deploy fail their digest check once), the Container host `sinaloa-container.internal`, the readiness probe key and the test and stress prefixes.
- **The old beta host `beta.sinaloa-inbox.com`.** Retire the route and the edge allowlist entry with the domain release.
- **Neon:** rename projects and databases (cosmetic, dashboard only).
- **Local folder:** rename `D:\vsc\NEU\Sinaloa` between work sessions, and recreate the agent worktrees afterwards.

## 5. Decisions for the human (answered in §0)

1. **Timing of N1.** Do the agent-facing renames before H-5, so beta users upgrade once (recommended), or after Phase A?
2. **Alias window.** How long the old MCP tool names, token prefix and SDK names keep working after H-5. The proposal is at least 30 days, announced to beta users.
3. **N3.** Rename infrastructure (database, Cloudflare, Neon) or leave it internal.
4. **Beta now.** The beta connector expects `sinaloa`, but beta's server says `envoi`. There are three options:
   - wait for H-5;
   - ship an Envoi-accepting connector to beta earlier, which needs a merge to `main` and a deploy;
   - temporarily report `sinaloa` on beta.

## 6. How this fits the build

- **N1:** contract `envoi-names v1` (Lane A), published for Lane B ACK and human approval like `a3`/`a4`. Server aliases go in a Lane A PR, and client renames in Lane B PRs. Everything is integrated before the GA hosted gate, so GA tests the all-Envoi connector.
- **N2:** small Lane A/B PRs after N1. Dashboard and alert steps are human tasks on the build board.
- **N3:** separate runbook PRs, only if approved.

None of this delays the current wave. A-2 (`a4-wake`) and the GA3 rerun continue in parallel.
