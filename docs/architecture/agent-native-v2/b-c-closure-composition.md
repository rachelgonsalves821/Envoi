# B/C closure: combined integration candidate and acceptance handoff

Prepared 2026-10-23 by Lane A against integration `d05498d8dc13c6f07dc151da7a41a1619ff62436` (board #34 comment 6371328798). This is a **rehearsal candidate and a handoff**, not an integration, deployment or approval. Merge authority exists only where the human has recorded an exact approval for an exact head; none is requested or implied here. Both `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` stay OFF, Stage A's candidate, batch and receiver are unchanged, and Phase D (Rachel, PR #211) is untouched.

## 1. What was selected, once

Every owner head was fetched at its current tip on 2026-10-23 and compared with `git cherry` against `d05498d`, so content already integrated is not replayed.

| PR | Owner | Exact head | Patch status vs `d05498d` | In the candidate |
| --- | --- | --- | --- | --- |
| #192 P0 client completion | Lane B | `fe7e0e9` | all 4 commits already integrated through #199 (`244c117`) | **No: duplicate** |
| #195 security vitest | Lane B | `bba852a` | already integrated through #199 | **No: duplicate** |
| #206 offline composition | Lane B | `e0d0e9f` | 43 new patches; contains #179 `0997f0f`, #182 `83ee8bf`, #190 `dc1cbfc`, #204 `35c279d` as ancestors | **Yes**, once, in place of its four constituents |
| #179, #182, #190, #204 | Lane B | see above | ancestors of #206 | **No: not replayed** |
| #193 artifact preflight | Lane B | `0693557` | 1 new | Yes |
| #196 offline remote-MCP setup | Lane B | `7ec6c1e` | 2 new | Yes |
| #183 on-demand owner presence | Lane B | `3c21f3b` | 1 new (generated overlap) | Yes |
| #111, #117 distribution | Lane B | `8a6d1b7`, `03c105f` | patch-subsets of #119 | **No: subsets of #119** |
| #119 distribution launchers | Lane B | `4776200` | 4 new (#111 and #117 patches plus one) | Yes, once |
| #207 Python quickstart | Lane B (Rachel) | `aab146b` | 1 new; **Lane B correction pending** (comment 6371233202) | Yes, at the current head |
| #209 TypeScript quickstart | Lane B (Rachel) | `39c6251` | 1 new; **Lane B correction pending** | Yes, at the current head |
| #210 connector persistence | Lane B (Rachel) | `9fa5c50` | 1 new (generated overlap); independently reviewed (6371822770) | Yes |
| #212 closure audit | Lane B | `bb64e91` | 1 new (docs) | Yes |
| #213 FileStore Windows replacement | Lane A | `46c5be6` | new | Yes |
| #214 status reconciliation | Lane A | `5414c23` | new | Yes |
| #191 website preview, #184 hosted-prep evidence | Lane B | `8d3b42a`, `a6f1d77` | new, **not in the requested set** | **No** (not selected) |
| #215 to #218 new Lane A contracts | Lane A | published, unapproved | new | **No**: each needs Lane B ACK and the human's exact approval first |

## 2. The candidate

Branch `lane-a/COMP-bc-closure-candidate` from `d05498d`. Order and method: ordinary merge commits (`--no-ff`), so every owner commit remains an ancestor and nothing is cherry-picked or rewritten: #206, #193, #196, #183, #119, #207, #209, #210, #212, #213, #214. The only conflicts were generated files (`web/index.html`, `web/downloads/envoi-connector.mjs`, `web/downloads/release.json`), taken from one side and then **regenerated once with `npm run build`** in a separate commit; a second `npm run build` leaves `git status` empty. No Lane B source file was edited by Lane A, and no Lane A path was changed except by #213 and #214.

## 3. Exact-head checks at `676a904a66adcd9323513db012352d0a522d97b7`

Windows 11, Node 22.15.0, PowerShell, native `whoami`; initial failures are kept.

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build`, then `git status` (run twice) | clean (generated outputs equal their sources) |
| `npm test` | 767 pass, **4 fail**, 34 skips. All 4 are `test/ci-start-postgres.test.js` (WSL `C:Windowssystem32ash.exe` resolves first). The same file with Git Bash first on PATH: 4/4 pass. The 34 skips are the PostgreSQL-only cases that CI runs. |
| scanner / stress-local / `cf:check` (dry runs) / `npm audit --audit-level=high` | 14/14 / PASS / PASS / 0 vulnerabilities |
| frontend / TypeScript SDK / Python SDK | 509/509 / 550/550 / 8/8 |
| integrations, checkout on `D:` | 976 pass, **2 fail**, 4 skips, reproduced twice and in isolation: `integrations/onboarding/test/portable-rest-runtime.test.ts` ("Windows could not restrict credential storage to your account", `privateDirectory` in `integrations/connector/store.ts`). The test makes its state directory under `process.cwd()`. |
| integrations, same SHA, checkout under `C:Users…Temp` | **978 pass, 0 fail**, 4 skips. The failure depends on where the checkout lives; the root cause on the `D:` tree is **not** diagnosed (volumes are both NTFS and an equivalent `Set-Acl` works there). Lane B owns that file and its portability; nothing was skipped, loosened or given a longer timeout. |

PostgreSQL, the production container build and the fail-closed configuration check run in the PR's CI; their result is recorded on the PR and board #34, not here.

## 4. Rollback

- **Source:** revert the candidate's merge range, or reset integration to `d05498d` only through the human; no force push is used by agents.
- **Server only:** revert #213 (restores the single rename) and #214 (docs).
- **Client only:** the merge commits for #206, #193, #196, #183, #119, #207, #209, #210, #212 are independent of the server changes; generated outputs are regenerated by `npm run build` after any revert.
- **Flags and data:** no flag is changed and no schema or storage format is introduced, so application data stays compatible in both directions.
- **Not executed:** a Worker, image or settings rollback; this is source rollback evidence only.

## 5. Remaining, by owner (nothing here is a pass)

| Gate | Owner and input | Next action |
| --- | --- | --- |
| #207 and #209 quickstart corrections | Lane B (comment 6371233202) | push corrected heads; they change README/examples only, so only the SDK suites need re-running |
| Contract ACK then approval for `mcp-wake`, `provider-event-wake`, `provider-gateway-native`, `provider-connector-tools` | Lane B ACK, then the human's exact approval | review PRs #215 to #218; no dependent implementation before |
| Implementation of approved contracts | Lane A, after approval | claim on #34 first |
| Flag-on acceptance, named-host wake, Muse, Instinct, Dots, Grok | human and account owners | real-host, provider-account and hosted evidence; none was run |
| Provider registration/submission | Rachel | outside Lane A |
| WorkOS Production cutover | release owner | separate track |
| Merge of any item above | the human | exact approval per head |
