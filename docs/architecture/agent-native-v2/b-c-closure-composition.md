# B/C closure: single client/server candidate, manifest and acceptance handoff

Prepared 2026-10-23 by Lane A. Replaces the earlier composition recorded at `99544d26645b742823d186fa93440897b65ac548` (kept recoverable as branch `lane-a/backup/COMP-bc-closure-candidate-99544d2`). This is a **review candidate, not an integration**. Merge authority exists only where the human records an exact approval for an exact head; none is used here. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` stay OFF, Stage A's candidate, batch and receiver are unchanged, Phase D (Rachel, PR #211) is untouched, and new contract PRs #215 to #218 are excluded.

## 1. Selected inputs (each once)

Base: integration `d05498d8dc13c6f07dc151da7a41a1619ff62436` (authorization, P0 and WorkOS preparation are ancestors and are preserved).

| Order | Input | Exact head | Owner | Why |
| --- | --- | --- | --- | --- |
| 1 | #219 corrected B/C client source | `8c1721c80c34e20026f70fb8408a5cf1f878eebb` | Lane B | The one client selection. A linear stack on `d05498d` whose commits prepare, without generated output, the content of #206 `e0d0e9f` (itself containing #179, #182, #190, #204), #183 `3c21f3b`, #196 `7ec6c1e`, #193 `0693557`, #210 `9fa5c50`, #207 `aab146b`, #209 `39c6251`, #119 `4776200` (containing #111 and #117) and #212 `bb64e91`, then adds its own corrections (section 2) and the regenerated `web/**` |
| 2 | #213 FileStore Windows replacement | `46c5be639b4d90cc554390004a0b09d46b2e3636` | Lane A | `src/storage.js` and `test/file-store-replace.test.js`, byte-identical to #213 (`git diff` empty) |
| 3 | #214 status-only reconciliation | `5414c2368dee996a2e079da72c195a1535879762` | Lane A | Separately identified increment: statuses from recorded approvals plus `contract-status.md`; schema and fixture bytes unchanged |

Method: ordinary merge commits, so every owner commit stays an ancestor. No conflicts arose. `web/**` equals #219's and `npm run build` regenerates it with no change (run twice).

**Excluded duplicates and supersessions (not replayed):** #206, #179, #182, #190, #204, #183, #196, #193, #210, #207, #209, #111, #117, #119 and #212 (content is inside #219; replaying any of them would resurrect the older selection); #192 and #195 (patch-identical to content already integrated through #199); the earlier #220 composition (backup ref above); #191 and #184 (not selected); #215 to #218 (new contracts, unACKed and unapproved).

## 2. What #219 corrects, and why the earlier composition was not equivalent

The earlier #220 lacked these #219 corrections and has been replaced, not added to. They are preserved unchanged (Lane B owns the files; Lane A edited none): optional exact `envoi-rest-host.mjs` support in private package manifests; verification of every declared artifact's hash and size; individual required-name checks and rejection of comma-containing filenames; the existing two-artifact compatibility and unknown-artifact refusal; prepare, install, tampering and filename-confusion regressions; Python native-work HTTP 410 guidance and fenced connector completion; TypeScript `CaseToolsClient`, scoped tools and assets and stable-code lifecycle documentation; current integrated-status guidance and historical acceptance credit.

## 3. Generated artifacts (identical to #219)

| File | SHA-256 | Bytes |
| --- | --- | --- |
| `web/downloads/envoi-connector.mjs` | `e833c7897df4127015de942a26b877f6020474868418e80570b4041c44f3becd` | 470850 |
| `web/downloads/envoi-openclaw.mjs` | `46c364231f90282a59b6a291960c97e78bbb3317be43d6fba468972b21619b2c` | 387488 |
| `web/index.html` | `c0b1ecc768c4e8d037fa42b1d1283a3109799fbdf8fb0f94ec89fc09628eb600` | |

`web/downloads/release.json` lists the two downloads above. The optional private `envoi-rest-host.mjs` is built under `integrations/onboarding/dist` and is covered by #219's package manifest checks, not by `release.json`.

## 4. D-drive portable-REST failure

See the section "Windows results" below and board #34 REQUEST lane-b 6373593962. Diagnosis: on a `D:` checkout the account's only inherited right is `Authenticated Users:(M)` (no `WRITE_OWNER`) and Administrators is deny-only in a non-elevated token, so the script's `SetOwner` inside `DirectoryInfo.SetAccessControl` throws `UnauthorizedAccessException`; under `C:\…\Temp` the account has an explicit inherited Full Control. The fix and its D-drive validation belong to the existing Lane B owner; this candidate carries no workaround.

## 5. Rollback

Rollback preserves `d05498d`: revert the three merge commits (or, server only, revert #213 then #214; client only, revert the #219 merge and run `npm run build`). Do **not** reset to an older input branch. No flag, schema or storage change is introduced, so application data is compatible in both directions. Source rollback only; no Worker, image or settings rollback was executed.

## 6. Remaining

Independent review of #219's 86-file delta and of this composition; the Lane B D-drive fix (incorporated once when published); the human's separate integration decision for an exact head, then Lane A's resulting-integration push CI; new contracts, hosts, providers and operational gates stay separate, and historical accepted B/C evidence stays credited (no blanket hosted rerun).

## 7. Windows results at the checked SHA `e05acd691a85bf44859701eae0a6e706c915c995`

Windows 11 10.0.26300, Node v22.15.0, Windows PowerShell 5.1.26100.9711, native `C:\Windows\system32\whoami.exe`, checkout on `D:` unless stated. Initial failures are kept; none is an assertion, timeout or skip change.

| Check | Result |
| --- | --- |
| typecheck (root, SDK, integrations) | PASS |
| #213 held-reader recovery/exhaustion, rollback, outbox attempt accounting (`test/file-store-replace.test.js`), with http-wake, a3 held-work, consumer-isolation, storage-transactions, outbox-held, delivery-worker | 56 pass / 0 fail / 16 PostgreSQL-only skips (72 tests) |
| `npm test`, full Windows backend | 805 tests: 767 pass, **4 fail**, 34 skips. All 4 are `test/ci-start-postgres.test.js` (WSL `C:\Windows\system32\bash.exe` resolves first and cannot read Git Bash `/d/...` paths): an **environment** finding, not a source change |
| same file with Git Bash first, in a child shell only | 4/4 pass (environment correction; the other steps ran with the default PATH) |
| scanner / stress-local / `cf:check` dry runs / `npm audit --audit-level=high` | 14/14 / PASS / PASS / 0 vulnerabilities |
| frontend / TypeScript SDK / Python SDK | 509/509 / 550/550 / 8/8 |
| portable REST and `integrations/distribution` artifact, installer, tampering and filename regressions, `D:` checkout | 67 pass, **2 fail**, 3 skips: both `portable-rest-runtime.test.ts` (D-drive secure-storage failure, section 4) |
| full integrations, `D:` checkout | 978 pass, **2 fail** (the same two), 4 skips |
| full integrations, same SHA, `C:` checkout | 980 pass, 0 fail, 4 skips. This does **not** clear the D-drive result and is not used as a substitute |
| `npm run build` twice, then `git status` | clean; generated output equals its sources |

**Status:** the two `D:` failures are BLOCKED on the existing Lane B owner (board #34 REQUEST lane-b 6373593962). Until that bounded fix is published and incorporated, the D-drive required checks are not green and this candidate is not READY. PostgreSQL, the production container build and fail-closed startup are in this PR's fresh exact-head CI.
