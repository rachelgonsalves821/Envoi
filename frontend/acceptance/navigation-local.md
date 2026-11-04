# Local navigation verification — 2026-11-03

Synthetic fixture: `node frontend/acceptance/navigation-fixture.mjs`, loopback 127.0.0.1:5186, Vite serving this worktree's actual App. No application server, credentials, database, real agent or external runtime. Uses the existing preview case data as synthetic fixtures, with a root and two child inboxes. GET /__fixture/control changes only in-memory synthetic delay/refusal behavior. The fixture was stopped after this sweep.

Observed with the computer-use browser API:

- Files → browser Back → Inbox → Forward → Files restored both URL section and visible heading.
- A six-second Milo snapshot delay kept the existing root Files view and URL visible. After authorization, Milo's inbox and its URL committed together.
- Denied Iris click retained Milo's inbox and URL; denial feedback appeared.
- Opened a source-qualified Milo case, Back restored its inbox list, Forward restored the exact case, and page refresh restored that same case from its URL.
- Manage agents → Connect used the client route; browser Back restored the retained Manage agents view.
- Manage agents → Claim → Back to workspace restored Manage agents. The initial sweep found the bare /app return URL would lose section on refresh; after canonicalization, the return URL contained inbox/section and refresh restored Manage agents.
- Started a six-second Iris selection, then selected Files in Milo. Files committed immediately. After the delayed response arrived, the view and URL still showed Milo Files.
- Created an authorized Iris history entry, returned to Milo, then denied Iris in the fixture. Browser Back kept Milo visible, showed refusal feedback, and replaced the inaccessible history URL with Milo's committed URL.
- Launch folder selection wrote its folder identifier to the URL. Refresh kept the Launch heading and folder filter.

Screenshot retained outside the source tree: navigation-authorized-view.png in this task's artifact directory. It shows the retained authorized Milo view after a denied history restore. This is synthetic UI evidence, not a hosted acceptance receipt.

Continuation sweep, same production source at a815058:

- A delayed Iris switch was interrupted by clicking Connect from Manage agents. Connect remained the URL after the delayed read finished; browser Back restored Milo Manage agents, not Iris.
- Direct /claim rendered the claim page and retained that page on refresh.
- Direct /authorize-agent?request=synthetic-one rendered owner approval. Clicking the fixture's canonical request=synthetic-two link changed the request in the same document (unchanged synthetic-document DOM marker). The fixture request log recorded GETs for both exact authorization-request paths. Refresh retained request=synthetic-two. Both requests were inert synthetic refusals; no consent or credentials were issued.
- The fixture sign-in link at /api/auth/workos/sign-in?returnTo=%2Fapp navigated the document to its synthetic identity-provider page. Browser Back restored the app. Clicking the actual app Sign out button POSTed /api/auth/logout, waited for its synthetic confirmation, then navigated to /fixture-signed-out, displaying Synthetic sign-out confirmed.
- External origins, authentication paths, downloads, target=_blank, modifier keys and non-primary buttons remain native-browser cases in the reused internalRoute regression test. These are router-boundary tests; no external provider or website was visited.

Fixture-only route links are injected by the acceptance runner, never imported into the distributed app. An initial query probe used handle rather than the canonical request key; it was correctly treated as unavailable and is not counted as query-restoration evidence. The valid canonical-key sweep and exact GET records above are the evidence. Synthetic request records and navigation-auth-boundaries.png are retained in the task artifact directory. Both fixture processes were explicitly stopped after their sweeps.

Delivery evidence: all required local checks and the generated rebuild pass. The source overlap audit is recorded in ../NAVIGATION_EXTRACTION.md; final exact-commit CI is maintained in the draft PR.

Checks so far: typecheck passed after URL initialization/canonicalization fixes; 33 focused tests passed. Full frontend before the final fixes passed 561/561. The subsequent Node 24 full run recorded 560 passed / 1 failure: local-human-journey's existing local-server startup timer expired while the synthetic fixture was running. Assertions/timeouts/skips are unchanged. After stopping the fixture, the isolated test passed 1/1, the full frontend rerun passed 561/561, TypeScript SDK 611/611, integrations 1483 passed / 4 existing skips, Python 8/8, typecheck and npm run build passed. The backend/download suite completed with 1004 passed, zero failures and 55 existing optional local skips. Final CI evidence is recorded in the PR.
