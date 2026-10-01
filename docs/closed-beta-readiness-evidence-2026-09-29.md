# Closed-beta readiness evidence — 2026-09-29

## Scope and source identity

Reviewed merged `origin/main` baseline **`fc2e1d8b72280789e365e9f8b8e399717933ccb6`**, PR #6, against the user-supplied closed-beta launch audit. Work is isolated on **`codex/beta-launch-readiness`**, with distinct agent file ownership. The original checkout was preserved. The audit's operational instructions were treated as evidence and proposed gates; no deployment, invitation or provider mutation was performed here.

Baseline [GitHub CI run 36644026164](https://github.com/rachelgonsalves821/Sinaloa/actions/runs/36644026164) predates these changes. The readiness implementation commit `cef2909ccbefcb4ca176d089e4ab043cef12cc34` is published in draft [PR #7](https://github.com/rachelgonsalves821/Sinaloa/pull/7). Its [CI run 36663216467](https://github.com/rachelgonsalves821/Sinaloa/actions/runs/36663216467) completed successfully, including actual production Docker build, fail-closed startup and all six disposable PostgreSQL regressions with zero skips. Review and merge remain required; any subsequent candidate commit must also pass CI. Record that full SHA from Git and use it on both environments; this document does not identify the readiness branch as an accepted release.

## Changes and reproduced failures

| Area | Finding and implemented correction | Local proof |
| --- | --- | --- |
| REST abuse | Rotating invalid bearer/cookie values bypassed principal-only admission. Apply stable trusted source-IP bounds before bearer/cookie resolution on all routes. | Regression failed before fix with request 181 returning 401; now returns 429 despite rotated cookies/tokens and spoofed forwarding. |
| Scanner preflight | Production accepted a scanner URL without its required bearer. Require nonblank app scanner token; diagnostics expose only names. | Missing, empty and whitespace token cases fail; development remains supported. |
| WorkOS renewal | Expired access JWTs were not renewed. Serialize provider refresh per sealed cookie, reauthenticate the renewed JWT, recheck verified/invited admission, emit secure replacement cookie on HTTP responses. | Concurrent renewals, provider/revocation/error negatives, valid-session reuse, logout and actual HTTP cookie regressions. |
| WorkOS callback/identity | OAuth state lacked browser binding; parallel first callbacks could create divergent human records. Add short-lived HttpOnly browser nonce cookie and transactional provider-user identity/index writes. | Missing/mismatched browser binding does not consume state; parallel sign-ins yield one human and failed writes roll back. |
| File size/quota | Presigned size was not bound and rejected/abandoned bytes could remain while quota released. Sign body length, bound object reads, reserve quota with metadata transactionally, retain holds through durable cleanup, seal deleted keys with private conditional zero-byte tombstones, preserve legacy verified quarantine records. | Wrong size/checksum, failed cleanup/retry, late PUT, quota retention, concurrency, legacy records and scan recovery regressions. Real R2/browser behavior remains pending. |
| Scanner transport | Startup had a deadline but TCP writes/reads could stall indefinitely. One 180-second deadline covers startup/open/retry/write/read and releases resources. | Short injected deadlines reproduce all stalled stages; framing/verdict/cleanup and public bearer admission tests. |
| Release target/identity | Beta allowed a workers.dev host inconsistent with its custom-origin config; promotion had no exact-source identity proof. Disable beta workers.dev; guard clean checkout, recorded SHA, fetched main and explicit target/account; require encrypted secret names for live promotion; return SHA on health/readiness and check both in smoke. | Target mutations, provenance/secret-name regressions and staging/beta/scanner packaging dry-runs. |
| Recovery/migration | Empty-schema restores do not prove recovery and Windows CRLF changed SQL checksums. Add read-only populated database fingerprint verifier; force migration LF checkout. | Restore comparisons, TLS/isolation/redaction regressions; all four local SQL files byte-identical to main. No applied SQL changed. |

The TypeScript SDK fixture also dropped a timing-dependent assertion that expected a 50 ms retry window still to be open after unrelated async work. Eventual retry/deduplication assertions and backend lease/backoff tests remain.

## Local verification

| Command/check | Result |
| --- | --- |
| `npm ci` | Lockfile install; 0 vulnerabilities reported |
| Final `npm test` | **185 passed, 10 skipped, 0 failed** (195 tests including subtests) |
| `node --test scanner/*.test.js` | **14 passed**, 0 skipped |
| `npm run test:frontend` | **61 passed** |
| `npm run test:sdk:typescript` | **37 passed** after fixture correction |
| `npm run test:sdk:python` | **4 passed** |
| Bridges with `SINALOA_P2_SERVER_ENTRY` pointing to this checkout | **26 passed**, 0 skipped, including real local MCP server fixture |
| `node scripts/stress-local.mjs` | PASS: separate cases, concurrent writes/reads/MCP, idempotency and denied injections/spoofs, fixed/rotating invalid bearer flood |
| `npm run build` | Typecheck and production frontend build passed |
| `npm run cf:check` | Target validation, **6 Worker tests**, and staging app / beta app / beta scanner Wrangler dry-runs passed; no Container rollout |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| Scanner/server syntax and `git diff --check` | Passed |

The ten backend skips are six PostgreSQL regressions and four live R2/scanner regressions. No disposable PostgreSQL URL, private live storage/scanner credentials, or Docker runtime was available. CI subsequently passed its disposable PostgreSQL and actual production Docker build/fail-closed-startup gates on the implementation commit above; Rachel must still run the opted-in live provider tests on isolated test resources. Unit/fixture bridges do not prove real OpenClaw Gateway or xAI provider behavior. The populated restore helper was tested with fixtures, not hosted restored data.

## Migration byte identity

| Immutable migration | SHA-256 (matches Git main and LF working bytes) |
| --- | --- |
| `001_documents.sql` | `a3ea83cb643dcc087228ab48b2cf86a5e47fade9f7ee0f90f764375663d465f3` |
| `002_object_storage.sql` | `f002b4412258a75d0ed40e13112466f9ddf05349979997503556aa9aff4e58d2` |
| `003_delivery.sql` | `c5cd1a381de8f38edadc731558517ab419d8875f93ed188c39c956c40cd610e8` |
| `004_history_indexes.sql` | `f7cd8b59365e97356b5339565ada97a634ab31e66d0272f9fe7f36ab136f32d3` |

## Read-only hosted observations and user decisions

Fresh HTTPS fetches returned staging health 200 (production config validated), readiness 200 (ready) and auth config 200 (WorkOS). The responses did not include releaseSha, so deployed main/candidate identity is unproven. Beta health returned 500; unauthenticated beta scanner health returned 401. No authenticated beta scanner proof is available from this session.

The user confirms staging-only secrets, Rachel executing hosted commands and alerts reaching both owners. Local Wrangler selects a different account; no local deployment is authorized through that identity. GitHub CLI had no configured login, but the existing Git credential authenticated branch publication and draft PR creation privately after the connector returned insufficient PR permission. No credential value was logged. Alert destinations, primary responder and R2 renewal owner remain undecided. The previously recorded R2 expiry is 2026-10-29 and requires private provider confirmation/renewal planning.

## Rachel's next execution gates

Use the [launch runbook](closed-beta-launch-runbook.md) in order:

1. Review and merge these fixes; require green final-candidate CI. Freeze competing staging Builds and record full SHA, prior Worker version/image digest and migration compatibility.
2. Enter nine beta-only app encrypted secrets plus the matching beta scanner token privately; verify resource identities, callbacks/CORS and durable backup policy. Prove authenticated scanner health/verdict/timeout behavior.
3. Back up and migrate the intended staging database, dry-run and deploy the clean accepted merged SHA with `scripts/promote-release.mjs`, then smoke both releaseSha responses.
4. Prove two humans, real OpenClaw/xAI behavior, file/quota/scanner negatives, controls/revocation, renewal and restart. Restore populated data to isolated resources and verify rows, R2 bytes, keys and queue recovery; rehearse compatible rollback.
5. Assign and test alert delivery to both owners and renewal/response ownership. Promote the same accepted SHA to beta, bind the custom hostname and repeat critical beta acceptance before cohort admission/signoff.

Owner/manager R2 GET signatures last up to the already-issued 300-second TTL; recipient URLs recheck access in the app on every fetch. Expired long-interrupted upload workflows require a new logical upload key. Cleanup tombstones must remain private and be preserved from bucket lifecycle deletion. These behaviors need hosted acceptance and tester expectations.

**Launch verdict: not yet ready for cohort admission.** Local corrections are reviewable; provider, product, recovery and operational gates above are pending.
