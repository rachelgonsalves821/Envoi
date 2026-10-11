# Agent-native v2 Step 0 baseline

Checked 2026-10-07, before A1 code changes. The isolated Step 0 worktree starts from `origin/main` at `376c760bc100b38c8f1c9f689875019f58327724` (PR #28 merge). The primary `Sinaloa` checkout is 158 commits behind its tracked `origin/main` and has pre-existing uncommitted server/config/test files plus policy-engine files. It was **not changed, cleaned, stashed, or merged**. The separate Instinct research branch is not included in this code baseline.

## Required local baseline

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 279 passed, 10 skipped (rerun outside restricted sandbox for Windows ACL tests) |
| `npm run test:frontend` | PASS: 200 |
| `npm run test:sdk:typescript` | PASS: 75 |
| `npm run test:integrations` | PASS: 176 passed, 1 skipped (rerun outside restricted sandbox for Windows ACL tests) |
| `npm run test:sdk:python` | PASS: 4 |
| `node --test scanner/*.test.js` | PASS: 14 |
| `node scripts/stress-local.mjs` | PASS: bounded local fixture |
| `npm run build` | PASS, including typecheck and connector bundles |
| `npm run cf:check` | PASS: configuration, six Worker tests, staging/beta/scanner Wrangler dry runs (rerun outside restricted sandbox for Wrangler filesystem access) |
| `npm run test:postgres` | Local run skips without a database; the Step 0 PR's GitHub Actions job uses its isolated PostgreSQL service and must pass on the exact Step 0 commit. |
| Docker build | Docker CLI is unavailable on this Windows host; the same PR's GitHub Actions job builds the actual `Dockerfile.cloudflare` image and tests fail-closed startup. |
| `npm audit --omit=dev --audit-level=high` | PASS: zero production-dependency findings |
| Full `npm audit --audit-level=high` | Initial baseline failed with seven high-severity development-tool findings. The Step 0 candidate removes `vite-plugin-singlefile` (the `braces` parent has no published fix) and overrides `sharp` to 0.35.5 and `source-map-js` to 1.2.2. The updated lockfile audit passes with zero findings; CI now enforces the full audit. |
| Self-contained web output | PASS: `npm run build` emits `web/index.html` byte-for-byte identical to the prior build, with no external script or stylesheet references. |

The first sandboxed backend and integration runs failed in Windows credential-file ACL fixtures because the restricted user could not set permissions in temporary directories. The same exact suites passed outside the sandbox. This is an execution-environment distinction, not an application fix.

## Hosted baseline

Read-only checks at 2026-10-07 23:07 UTC:

| Origin | `/health` | `/ready` | Release evidence |
| --- | --- | --- | --- |
| `https://www.envoi-agents.com` | 200, `ok: true` | 200; database, object storage, and malware scanner each `ready: true` | Both responses report SHA `376c760bc100b38c8f1c9f689875019f58327724`. |
| `https://sinaloa-staging.rachelgonsalves821.workers.dev` | 200, `ok: true` | 200; same three critical checks ready | `releaseSha: null`; this does not prove an exact staging commit. |

Neither readiness nor local tests establish the Phase A real-Hermes acceptance fixture. No deployment was performed. The beta host reports an exact SHA and is suitable as a *baseline* reference; staging must report an exact SHA before it is used as a known-candidate acceptance target.

## Prior connector fixes

The current main tree already has Windows absolute-path handling in the Hermes connector, atomic private state-file replacement, `parseAgentReply` coverage, and recovery-oriented setup messages. These should be reviewed against the old branch only for a specific missing fix; the entire old branch must not be merged into A1.
