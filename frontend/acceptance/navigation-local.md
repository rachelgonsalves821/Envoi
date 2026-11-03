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

Still to verify before READY: interrupted switch followed by top-level Connect route; direct Claim/authorization route refresh and query-handle changes; explicit synthetic sign-out and source/fixture sign-in/external-link behavior. Repeat affected browser rows if subsequent source changes alter them. Finish all required local checks, generated rebuild, final commit CI, and current PR overlap audit.

Checks so far: typecheck passed after URL initialization/canonicalization fixes; 33 focused tests passed. Full frontend before the final fixes passed 561/561. The subsequent Node 24 full run recorded 560 passed / 1 failure: local-human-journey's existing local-server startup timer expired while the synthetic fixture was running. Assertions/timeouts/skips are unchanged; isolated test and full rerun after stopping the fixture are required.
