# Owner app load performance handoff

This handoff accompanies the Lane B navigation and inbox startup changes in PR #264. It separates measured historical latency from current build observations and identifies work owned by Lane A.

## Evidence

- The October 4 HAR analyzed in `docs/session-loading-fix-plan.md` showed a sign-in chain of approximately 8.5–10.1 seconds, ordinary workspace-view time to first byte of 2.5–3.3 seconds, and directory requests around two seconds. These are historical measurements; staging must be measured again at the candidate SHA.
- The current production build emits one `web/index.html` of 1,759,698 bytes. Its inline stylesheet is approximately 915,212 characters and its inline script approximately 843,019 characters. The build log reports about 859 KB gzipped for the HTML. These are local build sizes, not network timings.
- On October 31, the public staging `/health` endpoint reported release `c53a151becd807e31417e91114ad10475c425602`, which is not this PR's head. Three read-only `/app` shell requests from one Windows client returned 200, 1,756,677 bytes, and `Cache-Control: no-store, private`; elapsed request times were 2,218 ms, 1,703 ms, and 1,554 ms. These include client/network/transfer time and are not time-to-first-byte or authenticated inbox timings. They confirm the deployed shell is large and uncacheable, not that the PR's latency target has been reached.
- `scripts/vite-inline-web.ts` deliberately inlines one CSS and one JavaScript bundle and all assets. `src/server.js` serves the app shell for `/app`, `/claim`, `/connect`, and `/authorize-agent` with `Cache-Control: private, no-store`. A fresh document navigation therefore fetches the complete app again. Lane B's client-side routing removes that cost from internal navigation, but the first authenticated document still pays it.
- In `src/server.js`, `humanView` awaits its first group of reads, then processes grant metadata/access in sequence, then builds the participant directory, and finally awaits owner-agent state. Profile each stage and the underlying store operations in staging before changing ordering.

## Coordinated Lane A request

1. Measure cold sign-in and inbox-switch p50/p95 in staging at the same SHA and fixture. Record HTML transfer and parse time, organizations/workspaces request time, human-view time to first byte, response size, and request counts. Keep authentication and authorization failures in the sample review.
2. Separate the public, content-hashed JavaScript, CSS, and font assets from the private HTML shell. Serve the assets with long-lived immutable caching while keeping the HTML and authenticated API responses `private, no-store`. Update server static routing and CSP together with the root build plugin; do not ship a split build until the production Container can serve every emitted asset. Test nested app routes, nonce/CSP behavior, content types, and a repeated-login cache hit.
3. Profile `humanView` stages. Parallelize independent authorized reads with a bounded concurrency limit or batch store API, preserving requester checks and deterministic response semantics. Compare the same staging workload before and after, including revoked access, account changes, and rapid inbox switching.

`AGENTS.md` assigns `scripts/**` and `src/**` to Lane A. This file proposes their changes; PR #264 does not modify them. Lane B's frontend tests and local browser sweeps establish navigation behavior, not hosted latency improvement.
