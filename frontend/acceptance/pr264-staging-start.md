# PR #264 staging start and pass recipe

This is the hosted acceptance gate for the owner-app navigation and inbox-startup candidate in draft PR #264. A local build or green CI is candidate readiness, not a staging pass. The human release owner performs the staging deployment. Do not merge or deploy to beta as part of this recipe.

## 1. Freeze the candidate and fixture

Record the **full current PR head SHA** and exact-head Backend CI run. Use the same SHA for the deployed Worker, Container, browser assets, and this report. Record the previous staging SHA and rollback version before deployment. Use one approved disposable staging owner with a root inbox and two active agent inboxes, plus a second isolated owner/browser session for access checks. Do not use production identities, preview mode, development auth, new enrollment, or real model prompts just to satisfy this gate. Record the browser version, region, network profile, fixture inbox IDs privately, and UTC run time.

Current pre-deployment observation on November 1: staging `/health` and `/ready` report `2ae733473f5ee7b3f569b6513f67e2dfdc2b0005`, not PR #264's then-head `9afe61cdbee4ebb006e57cfc64d9d17d8e961fb4`. The exact-SHA smoke stopped at `/health`. Recheck both values at run time; the SHA in this paragraph is a dated observation, not an instruction to deploy it.

## 2. Human release-owner start

The current staging owner and PR owner agree on an exclusive UTC start/end window before any upload. Pause other staging deployments and Phase C tests during that window; identify who will deploy, who will run acceptance, and who can execute rollback. Record the live Worker deployment/version and Container application/image references immediately before starting, plus a tested command or dashboard path for restoring **both**. A Worker-only rollback can leave incompatible code and assets paired with the new Container image. If either rollback reference cannot be confirmed, do not start.

From a clean checkout of the reviewed PR head, the release owner records the SHA and CI result, then uses the explicit staging-only deploy helper. Preserve the three existing staging behaviors in this candidate: additional-email admission, same-origin WorkOS links, and the Create-account page. No beta or production target is part of this run. `promote-release.mjs --deploy` is not the path for this draft head: that helper requires HEAD to equal fetched `origin/main`.

```powershell
$candidate = git rev-parse HEAD
git status --porcelain
npm run cf:check
# Human release owner only, after reviewing the dry run and rollback target:
npm run cf:deploy:staging
node scripts/smoke-deployment.mjs https://sinaloa-staging.rachelgonsalves821.workers.dev $candidate
```

The smoke must pass `/health`, `/ready`, auth config, About, Product, app shell, team redirect, and WorkOS redirect at the **same SHA**. If `/health` or `/ready` differs, stop. Do not treat a passing public smoke as authenticated inbox acceptance.

If upload, readiness, smoke, or acceptance fails, the staging owner restores the recorded Worker version **and** Container image, then checks `/health` and `/ready` against the prior staging SHA and repeats the public smoke. Record both resulting references and any incomplete rollback in the handoff. End the exclusive window only after the candidate passes or the paired rollback is verified.

## 3. Browser and network acceptance

Use the same staging fixture for a before/after comparison. Capture the old release before deployment if it is still available; otherwise mark the comparison unavailable and do not claim an improvement ratio. In the browser Network panel enable Preserve log and disable cache for cold transfer runs; repeat with normal cache for warm runs. Keep HARs, cookies, personal data, and request bodies private. Record response status, bytes, TTFB, total transfer, and request count for HTML, JavaScript, CSS, `/api/auth/me`, organizations, workspaces, and each human-view request. Separate server wait from asset transfer and first client render.

For each release and the same fixture, collect at least 20 successful cold sign-in trials and 20 root↔agent inbox switches. Collect at least 20 warm reloads **after** the identifier cache is populated; report its first-population trial separately. Report nearest-rank p50/p95 for (a) successful authentication→first agent visible and (b) successful authentication→inbox content visible, plus switch click→new content visible. Include 401, 403, 429, failed requests, and retries in a separate error count rather than silently dropping them. Do not run tight reload loops that trigger normal rate limits.

Use the Network panel's Document filter while clicking All inboxes, Needs you, Done, folders, case detail, Files, Manage agents, Permissions, Activity, Connect, Claim, authorization, About→Product→About, and back. Each in-app transition must render without a blank screen or a new document request. Sign-in to WorkOS, confirmed sign-out, and explicit CSRF recovery are expected document navigations. During a delayed agent↔root switch, the current inbox stays visible until the new authorized view commits; rapid reverse clicks must not apply stale responses.

Check that a return visit serves the hashed JavaScript/CSS from browser cache while HTML and authenticated APIs remain private and uncacheable. Verify nested routes, content types, nonce/CSP behavior, and noindex on the app shell. Test denied child access, account change, and a removed child with the second staging owner. A provisional cached ID must never show another account's agent or survive a denied fresh view.

## 4. Bounded grant-read acceptance

Use a designated disposable shared-asset fixture with a fixed number of clean, pending, revoked, and unrelated-owner grants. Measure human-view p50/p95 and storage request concurrency/error rate on the previous and candidate releases under the same read load. Verify that no more than eight grant metadata/access reads run at once, no storage throttling or material p95 regression appears, and clean/granted assets alone are visible and downloadable to authorized owners. Pending, revoked, infected, and unrelated-owner assets must remain denied. Local tests establish the concurrency bound and authorization logic; hosted measurements establish storage impact.

## 5. Pass decision and record

Mark **PASS** only when exact-SHA health/readiness and smoke pass, all listed browser transitions and access checks pass, and both agent-display and inbox-content p50/p95 are recorded with the same fixture. Claim a *latency improvement* only if the before/after fixture and network conditions match and the measured candidate p50/p95 improve without increased errors or storage saturation. If old-release baseline is unavailable, report candidate absolute numbers and mark the comparison unverified. If the candidate is not deployed, mark **NOT RUN — exact-SHA deployment gate**. Any incorrect authorization, blank screen, stale switch, failed readiness, or storage saturation is **FAIL** with the smallest reproduction. Record SHA, CI URL, deploy/version reference, fixture description, browser version, timing table, error counts, result, and rollback decision in the PR handoff; never attach private HARs or credentials.
