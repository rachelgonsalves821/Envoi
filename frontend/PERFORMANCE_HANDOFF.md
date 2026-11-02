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

## November 1 local continuation

The local fixture is a disposable development-auth account with two synthetic agent inboxes. A loopback proxy adds 800 ms each to organization and workspace-directory responses and 100 ms to each human-view response. It uses the same root inbox and browser for every reload. Timings below are wall-clock time from browser reload to visible UI, with nearest-rank p50/p95; they are not production or staging timings.

| Root-inbox reload | Runs | Inbox content p50/p95 | Agent list p50/p95 |
| --- | ---: | ---: | ---: |
| Before the agent-inbox shortcut, after saved-root early rendering | 9 | 438/463 ms | 2,054/2,194 ms |
| After the shortcut, once its identifier cache was populated | 8 | 352/417 ms | 409/563 ms |

The first reload after installing the shortcut populated its identifier cache and showed the agent at 2,031 ms. The shortcut stores only child inbox IDs, parent IDs, and owner-agent IDs, scoped to the signed-in human. It starts child views after the root snapshot identifies the current requester; a child is rendered only after its own fresh snapshot confirms requester, provider, parent, and owner-agent identity. A removed or inaccessible child disappears when the directory returns. No agent names, addresses, grants, or content are read from browser storage.

The local production build emits 1,416 bytes of HTML, 844,897 bytes of JavaScript, and 147,691 bytes of CSS. HTML is private and uncacheable; hashed assets are immutable. In an isolated 15-request loopback sample before the final shortcut build, HTML TTFB p50/p95 was 14/15 ms, JavaScript 58/78 ms, and CSS 10/13 ms. A later sample while the full server suite was running was contended and is not used for comparison. The authenticated API fixture gave organizations 6/19 ms, workspaces 6/18 ms, and root human-view 10/16 ms p50/p95 TTFB across 15 requests. Under the deliberate proxy delays, organizations were 816/822 ms, workspaces 813/825 ms, and human-view 123/134 ms. The old agent-list wait was therefore dominated by directory discovery, not root content rendering.

Browser checks covered All inboxes, Needs you, Done, Files, Manage agents, Permissions, Activity, Launch folder, case detail, Connect, Claim, and authorization. About→Product→About rendered via Astro's ClientRouter. The current inbox remained visible while an agent selection was pending; its section changes only after the authorized snapshot commits. Sign-in to the identity provider and sign-out after server confirmation intentionally navigate the document. A CSRF recovery control intentionally reloads on explicit user action. No full-document reload was observed in the checked in-app routes; source routing and the navigation tests cover `/app`, `/claim`, `/connect`, and `/authorize-agent`.

The grant path caps metadata/access reads at eight concurrent items and preserves order. The bounded-read unit test checks that limit, and the asset-grant integration suite checks authorization. This fixture has no representative shared-grant workload, so it cannot establish storage saturation or a grant-read p50/p95 improvement. At the exact candidate SHA in staging, compare a fixed shared-grant fixture against the previous release while recording store concurrency, errors, and human-view p50/p95. Do not infer a hosted improvement from the local run or from staging at a different SHA.

Validation: production build passed; frontend 555/555 passed; server 993 passed, 59 skipped, 0 failed. The skipped server cases require optional external backends or services. The first sandboxed attempts failed because Windows isolation blocked temporary test files and local loopback ports; the same suites passed with those restrictions lifted.
