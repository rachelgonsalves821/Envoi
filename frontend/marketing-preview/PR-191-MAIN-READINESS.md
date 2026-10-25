# PR #191 → main readiness plan

Status: combined implementation in local verification, 2026-10-25. PR #191 remains a draft into `integration/agent-native`. A human approves merges and deployments.

## Intended release shape

Serve the reviewed About and Product pages from Envoi's production origin while keeping the authenticated workspace and agent onboarding usable. Preserve the existing WorkOS sign-in/sign-up flow and its same-origin return-path checks. The marketing copy and Monad visualization must describe the capability actually enabled in the release profile.

## Current evidence

- After explicit human authorization to edit Lane A paths, a candidate branch merged PR #191 head `8b9aa3b` with Je's PR #235 head `4264ca3` without conflicts. The candidate adds server routing, a reproducible root marketing build, WorkOS success return to `/app`, client workspace links, generated marketing assets, and route tests. This candidate has not been merged to main or deployed.
- PR #191 source head inspected at `a44d54e` changes only `frontend/**`. The Astro preview builds its own `dist/` with `/`, `/product/`, `/team/`, `/share/` and public assets. Its current build is not part of the root `npm run build`.
- The root build emits one inlined Vite `web/index.html`. The server serves that file for `/`, `/claim`, and `/connect`; it does not serve `/product/` or `/team/`. Existing auth callbacks return to `/` by default.
- `origin/main` is `e25e528`; PR #191 is 170 commits behind it. Je's draft PR #235, head `4264ca3` when inspected, is a guarded WorkOS/Hermes release candidate composed with current main. It has no marketing route integration. Recheck these SHAs at integration time.
- The production `/product/` and `/team/` routes returned 404 when last checked. The preview sets `noindex, nofollow`, appropriate for review but not public launch.
- Exact-head CI passed at `a44d54e` ([run 40205523319](https://github.com/rachelgonsalves821/Envoi/actions/runs/40205523319)); Je's PR #235 exact-head CI also passed at `4264ca3` ([run 40202880605](https://github.com/rachelgonsalves821/Envoi/actions/runs/40202880605)). These checks do not test a combined marketing/backend artifact.
- At PR #191's older root lock, `npm audit --audit-level=high` reports one high finding in Wrangler's development dependency chain and five moderate findings. Current main has a newer lockfile and an `undici` override, so audit the eventual integrated lock rather than carrying this result forward.
- The human confirmed on 2026-10-25 that Monad is enabled and verified and requested the Product copy remain exact. Je's selected beta `hermes-openclaw-preserve-monad` profile retains `ENVOI_MONAD_PERMISSIONS=true`; staging's core profile leaves it off. The combined release must retain the selected beta profile and verify its hosted evidence without treating staging's off state as a copy change request.

## Checks executed on source head `a44d54e`

| Check | Result | Scope |
| --- | --- | --- |
| Marketing `npm test` | 48 passed | Isolated Astro package |
| Marketing `npm run build` | 4 pages generated; route/anchor check passed | Isolated Astro package, with telemetry disabled in the restricted local environment |
| Marketing `npm run audit:security` | 0 vulnerabilities | Isolated Astro package |
| Root `npm run typecheck` and `npm run build` | Passed | Existing Vite app and connector artifacts; **does not include Astro** |
| Root `npm run test:frontend` | 430 passed | Existing app; run outside temp-file sandbox |
| Root `npm run test:sdk:typescript` | 548 passed | Existing SDK |
| Root `npm run test:integrations` | 869 passed, 1 skipped | Existing integrations |
| Root backend focused auth test | 10 passed | Existing backend; run outside sandbox |
| Root backend full `npm test` | Not completed locally; stopped after exact-head CI passed | No production marketing route coverage |

## Checks on the combined candidate

| Check | Result |
| --- | --- |
| Clean root dependency install | Passed; 0 npm vulnerabilities |
| Root `npm run build` including the new Astro packaging step | Passed |
| Root `npm run test:frontend` | 510 passed |
| Focused `marketing-routes`, `connect-routes`, and `workos-auth` server tests | 30 passed |
| Root full backend `npm test` | 944 passed, 56 skipped, 0 failed |
| Release smoke unit checks | 22 passed; rejects a missing Product route |

The combined server test confirms `/`, `/product/`, marketing CSS/images, `/app`, `/claim`, `/connect`, `/authorize-agent`, `/team/`, query-preserving redirects, the legacy enrollment query redirect, and CSP nonces. It does not replace a real hosted WorkOS callback test.

## Implemented route/build contract for review

Proposed route map for the combined release candidate (subject to the approved auth contract):

| Path | Response |
| --- | --- |
| `/` | Public About page; an authenticated visitor can still follow Start now or Sign in into the app. |
| `/product/` | Public Product page, directly refreshable. |
| `/team/` | Permanent redirect to `/#team`. |
| `/app` | Existing authenticated Vite application shell and post-WorkOS default return. |
| `/claim`, `/connect`, `/connect/*` | Preserve the existing registration/onboarding behavior and query/fragment handling. |
| Marketing asset paths | Serve built images, CSS, JS, and fonts with correct content type and existing CSP rules. |

The local candidate wires `src/server.js`, the root build, the WorkOS success default, and frontend workspace links on the same SHA. Existing callback-error redirects still point to `/?auth_error=...`; the public About page displays a generic sign-in failure notice. Existing `/?enroll=...` and `/?workspace=...` links redirect to `/app` with their query intact, preserving the published enrollment URL shape. Keep the old `/` application as the rollback target until the new route map passes the hosted gate.

## Execution gates

1. **Freeze the target SHA.** Fetch `main`, `integration/agent-native`, PR #191, and Je's release candidate. Reconcile their changed paths and contract versions. Keep PR #191 targeted at integration; do not infer that a clean preview branch is ready for main.
2. **Choose and implement production routing with Lane A.** Lane B supplies the built marketing pages and assets in `frontend/**`; Lane A owns `src/server.js`, root build/deploy scripts, and auth callback defaults. The agreed route contract must specify where authenticated users land, how `/claim` and `/connect` remain reachable, how `/product/` and `/team/` resolve, how marketing assets are served with correct MIME/CSP/cache behavior, and where WorkOS returns after sign-in/sign-up. Record the exact root-build and server patch as `REQUEST lane-a` before changing those paths.
3. **Make one build artifact reproducible.** A clean checkout's production build must produce the marketing pages and retain the application shell without manual copying from Astro `dist/`. Check asset references, logos, fonts, dark/light theme, redirects, and `robots`/sitemap/canonical metadata in the actual served result. Remove preview `noindex` only for the release artifact after public routes work.
4. **Verify the full user journey on the integrated SHA.** For desktop and mobile, visit About → Product → Start now → WorkOS sign-up → application, then Sign in → application. Verify `/team/` legacy redirect, anchor links, refresh/deep links, direct `/claim` and `/connect`, auth error return, logged-out and logged-in behavior, and back navigation. Use a safe test account in staging for callback checks; automated tests should cover route responses and static asset types.
5. **Check the current backend and claims.** Run root typecheck, build, frontend tests, integration/SDK tests and server tests on the integrated SHA. Preserve the human-confirmed Monad copy and beta preservation profile; verify the merged site and backend do not disable the enabled permission layer or imply that the illustrative toggles themselves grant real permissions.
6. **CI and hosted gate.** All required checks must pass at the exact merge candidate SHA. Lane A/human confirms a staging deployment's `/health` release SHA, `/ready`, auth redirects, marketing routes, and backend actions. Update PR description with tested commands, results, unresolved hosted evidence, and rollback target. The human decides when to merge and deploy.

## Exit criteria

PR #191 is ready for integration only when the preview is green and the routing/build/auth contract is accepted. It is ready for main only after the integrated candidate passes the route, backend, CI, and hosted gates above, with no contradictory release copy. A passing isolated Astro build alone does not meet this bar.
