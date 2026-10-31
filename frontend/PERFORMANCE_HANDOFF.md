# Owner app load performance handoff

This handoff accompanies the navigation, inbox startup, build, and server changes in PR #264. It separates measured historical latency from current build observations and identifies the hosted verification still needed.

## Evidence

- The October 4 HAR analyzed in `docs/session-loading-fix-plan.md` showed a sign-in chain of approximately 8.5–10.1 seconds, ordinary workspace-view time to first byte of 2.5–3.3 seconds, and directory requests around two seconds. These are historical measurements; staging must be measured again at the candidate SHA.
- Before this change, the production build emitted one `web/index.html` of 1,759,698 bytes. Its inline stylesheet was approximately 915,212 characters and its inline script approximately 843,019 characters. The build log reported about 859 KB gzipped for the HTML. These were local build sizes, not network timings.
- On October 31, the public staging `/health` endpoint reported release `c53a151becd807e31417e91114ad10475c425602`, which is not this PR's head. Three read-only `/app` shell requests from one Windows client returned 200, 1,756,677 bytes, and `Cache-Control: no-store, private`; elapsed request times were 2,218 ms, 1,703 ms, and 1,554 ms. These include client/network/transfer time and are not time-to-first-byte or authenticated inbox timings. They confirm the deployed shell is large and uncacheable, not that the PR's latency target has been reached.
- The new local build emits a 1.35 KB `web/index.html`, a 147.69 KB CSS file, an 843.20 KB JavaScript file, and content-hashed font assets. The server keeps HTML private and uncacheable while serving those hashed assets with `public, max-age=31536000, immutable`. The production Container copies the entire `web/` directory. The application also uses client-side routing for internal pages.
- `humanView` now overlaps independent list reads and runs authorized grant metadata/access reads with an eight-read limit. It overlaps participant-directory and owner-agent-state reads with those grant reads while preserving grant order. Local human-view, grant, and history integration tests pass; staging latency has not yet been measured at this candidate SHA.

## Hosted verification

1. Measure cold sign-in and inbox-switch p50/p95 in staging at the same SHA and fixture. Record HTML transfer and parse time, organizations/workspaces request time, human-view time to first byte, response size, and request counts. Keep authentication and authorization failures in the sample review.
2. At the deployed candidate SHA, verify nested app routes, nonce/CSP behavior, content types, a repeated-login cache hit for hashed assets, and private HTML/API responses. Local HTTP tests cover the app routes, asset content types, cache headers, and nonce insertion.
3. Compare the same staging workload before and after, including revoked access, account changes, and rapid inbox switching. Confirm backend timing improvements from the bounded reads and check for any data-store saturation at p95.

Rachel explicitly assigned the build and server files to this branch on October 31. The frontend tests and local browser sweeps establish navigation behavior, and the local server tests establish the split-asset delivery contract. Hosted latency improvement remains unverified until this candidate is deployed.
