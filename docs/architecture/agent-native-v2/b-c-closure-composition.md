# B/C closure: single client/server candidate, manifest and acceptance handoff

Prepared 2026-10-23 by Lane A. Replaces the earlier composition recorded at `99544d26645b742823d186fa93440897b65ac548` (kept recoverable as branch `lane-a/backup/COMP-bc-closure-candidate-99544d2`) and the interim head `8c0f67ee5a9c77a721e425d9dfe8386e514d6303`. This is a **review candidate, not an integration**. Merge authority exists only where the human records an exact approval for an exact head; none is used here. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` stay OFF, new flags default OFF, Stage A's candidate, batch and receiver are unchanged, Phase D (Rachel, PR #211) is untouched, and the new contract PRs #215 to #218 and their implementations are excluded.

## 1. Selected inputs (each once)

Base: integration `d05498d8dc13c6f07dc151da7a41a1619ff62436` (authorization, P0 and WorkOS preparation are ancestors and are preserved).

| Order | Input | Exact head | Owner | What enters |
| --- | --- | --- | --- | --- |
| 1 | #219 corrected B/C client source | `8c1721c80c34e20026f70fb8408a5cf1f878eebb` | Lane B | The one client selection: a linear stack on `d05498d` preparing, without generated output, the content of #206 `e0d0e9f` (containing #179, #182, #190, #204), #183, #196, #193, #210, #207, #209, #119 (containing #111 and #117) and #212, plus its own corrections (section 2) and regenerated `web/**` |
| 2 | #213 FileStore Windows replacement | `46c5be639b4d90cc554390004a0b09d46b2e3636` | Lane A | `src/storage.js` and `test/file-store-replace.test.js`, byte-identical to #213 |
| 3 | #214 status-only reconciliation | `5414c2368dee996a2e079da72c195a1535879762` | Lane A | Separately identified status increment; schema and fixture bytes unchanged |
| 4 | #221 owned-directory ACL fix, **source delta only** | `6fa50220ca31b4419739598dd113b9c5f89fb248` | Lane B (Codex) | `integrations/connector/store.ts`, `integrations/connector/private-directory-acl.test.ts`, `integrations/gates/WINDOWS-OWNED-DIRECTORY-ACL.md`, applied as one binary-safe patch `git diff --binary d05498d 6fa5022 -- <those three paths>` (patch sha256 `07a69d606b1af6c4db4a125b51c01b07ebe99375124d312db0781884cda9c7e8`, verified; blobs identical to #221's). #221's older-base generated downloads are **not** imported |

Method: ordinary merge commits for 1 to 3 (every owner commit stays an ancestor, no conflicts); 4 is one commit that applies the patch and the regenerated bundles. **Regeneration** on the combined source, never a hand merge: `node integrations/distribution/build-private-directory.mjs`, then `npm run build`; a further regeneration leaves `git status` empty.

**Excluded duplicates (not replayed):** #206, #179, #182, #190, #204, #183, #196, #193, #210, #207, #209, #111, #117, #119, #212 (all inside #219); #192 and #195 (patch-identical to content already integrated through #199); the earlier #220 heads (`99544d2`, `8c0f67e`); #191 and #184 (not selected); #215 to #218 (contracts, outside this candidate).

## 2. What #219 corrects (preserved unedited; Lane B owns the files)

Optional exact `envoi-rest-host.mjs` support in private package manifests; verification of every declared artifact's hash and size; individual required-name checks and rejection of comma-containing filenames; the existing two-artifact compatibility and unknown-artifact refusal; prepare, install, tampering and filename-confusion regressions; Python native-work HTTP 410 guidance and fenced connector completion; TypeScript `CaseToolsClient`, scoped tools/assets and stable-code lifecycle documentation; current integrated-status guidance and historical acceptance credit.

## 3. The D-drive failure and its fix (#221)

On a `D:` checkout `portable-rest-runtime.test.ts` failed because `privateDirectory` wrote the owner (`SetOwner`) and the account had only an inherited Modify right (no `WRITE_OWNER`) with Administrators deny-only. Diagnosis: board #34 REQUEST lane-b 6373593962. The fix (#221, Lane B) requires the existing owner to equal the native current SID, writes only a protected account-only DACL (never the owner), verifies owner, protected flag and the single non-inherited FullControl rule afterwards, refuses foreign owners, and keeps the canonical/symlink checks, the child `icacls` reset and POSIX `0700`. Nothing was loosened, skipped, retried, retimed, elevated or moved to `C:`.

## 4. Generated artifacts

| File | SHA-256 | Bytes |
| --- | --- | --- |
| `integrations/distribution/private-directory.mjs` | `a74ff46ef8dfe42560de9d48d5acfb20ed6483e4cf01b1a08ddb2ee336c960f4` | 3923 |
| `web/downloads/envoi-connector.mjs` | `25e7df85444a71a564a43ddb4a50615b5939a70908119725917fa10a4a1ac1aa` | 471761 |
| `web/downloads/envoi-openclaw.mjs` | `9582d7439ee295cc38bb1e411a0599a86bb5512931dba53e7ad3d6e5d4e629af` | 388399 |

These equal the values Lane B predicted for the composed source. `web/downloads/release.json` lists the two downloads; the optional private `envoi-rest-host.mjs` is covered by #219's package manifest checks.

## 5. Windows results at the checked source SHA `818794e4ad5c66588fd76687206c832ad11adfe4`

Checkout on `D:` (`D:\vsc\NEU\envoi-lane-a-comp3`), Windows 11 10.0.26300, Node v22.15.0, Windows PowerShell 5.1.26100.9711, sequential runs, native `C:\Windows\system32\whoami.exe` throughout. For `npm test` only, `C:\Program Files\Git\bin` was prepended in a child process (child `whoami` stayed `C:\Windows\system32\whoami.exe`, child `bash` was Git's; `Git\usr\bin` was not used) and the parent PATH was verified unchanged afterwards.

| Check | Result |
| --- | --- |
| focused: #221 ACL regressions, native Windows helper (`windows.test.ts`), unchanged `portable-rest-runtime.test.ts`, `integrations/distribution` incl. standalone bundle drift guard | 7 files, 75 pass, 0 fail, 3 skips (POSIX-only: install-file modes, POSIX launcher quoting, missing-Node launcher) |
| focused: #213 held-reader recovery/exhaustion, rollback and outbox accounting, with a3 held-work, consumer isolation, http-wake, storage-transactions, outbox-held, delivery-worker | 72 tests, 56 pass, 0 fail, 16 PostgreSQL-only skips |
| `npm run typecheck` | PASS |
| `npm test`, full Windows backend | 805 tests, **771 pass, 0 fail**, 34 skips (PostgreSQL-only), including `ci-start-postgres.test.js` |
| scanner / stress-local | 14/14 / PASS |
| frontend / TypeScript SDK / Python SDK | 509/509 / 550/550 / 8/8 |
| `npm run test:integrations` | 987 tests, **983 pass, 0 fail**, 4 skips: `real-assets.test.ts` (P2 real-server asset exchange, existing skip) and three POSIX-only distribution tests |
| `npm run cf:check` | PASS (three dry runs, nothing deployed) |
| `npm audit --omit=dev` / `--audit-level=high` | 0 vulnerabilities / 0 vulnerabilities |
| `npm run build` twice plus `build-private-directory.mjs`, then `git status` | clean |
| `git diff --check d05498d..HEAD` | clean |

This replaces the earlier four known WSL shell failures with an actual green full run. Linux CI evidence for the resulting head is on the PR.

## 6. Rollback

Rollback preserves `d05498d`: revert the candidate's merge range, or independently revert the #221 delta commit (this restores only the known Modify-only-volume failure, never a weaker ACL), then #213 and #214 (server), or the #219 merge (client), and run `npm run build`. Do **not** reset to an older input branch. No flag, schema or storage change is introduced, so application data is compatible in both directions. Source rollback only; no Worker, image or settings rollback was executed.

## 7. Remaining

Exact-head CI for the PR head (PostgreSQL, production container and fail-closed startup, generated equality, audits); independent review of #219's 86-file delta and of this composition; the human's separate integration decision for an exact head, then Lane A's resulting-integration push CI. New contracts, hosts, providers and operational gates stay separate, and historical accepted B/C evidence stays credited (no blanket hosted rerun).
