# B/C closure: single client/server candidate, manifest and acceptance handoff

Prepared 2026-10-24 by Lane A. Supersedes the composition reviewed at `70a7ce9da1ffb7207d3f20fe9ddb0f0a20ba33a3` (Lane B technical ACK, board #34 comment 6375547270, valid for its reviewed bytes only) and the earlier heads `8c0f67e` and `99544d2` (kept at branch `lane-a/backup/COMP-bc-closure-candidate-99544d2`). This is a **review candidate, not an integration**. Merge authority exists only where the human records an exact approval for an exact head; none is used here. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` stay OFF, new flags default OFF, Stage A's candidate, batch and receiver are unchanged, Phase D (Rachel, PR #211) is untouched, and contract PRs #215 to #218 and their implementations are excluded.

## 1. Baseline and selected inputs (each once)

**Current baseline:** `integration/agent-native` @ `48e40e510d9d021caa7f756c5044486aa7157d68`, which is `d05498d` (authorization, P0 and WorkOS) plus **#222** (six-file deployment-configuration increment, integrated and push-CI green: run 40031620800). The candidate is the baseline merged in, not a replacement of it.

| Order | Input | Exact head | Owner | What enters |
| --- | --- | --- | --- | --- |
| 0 | #222 deployment configuration | in baseline `48e40e5` | Lane A | `docs/deployment.md`, `scanner/wrangler.beta.jsonc`, `scanner/wrangler.jsonc`, `scripts/check-deployment.mjs`, `test/durable-object-lifecycle.test.js`, `wrangler.jsonc` (native SQLite exports declarations and lifecycle/deployment guards, with its documented deployment and recovery constraints). Preserved **once**, by merging the baseline; the six files are byte-identical to integration (`git diff origin/integration/agent-native HEAD -- <six paths>` is empty) |
| 1 | #219 corrected B/C client source | `8c1721c80c34e20026f70fb8408a5cf1f878eebb` | Lane B | The one client selection (prepared content of #206, #183, #196, #193, #210, #207, #209, #119/#111/#117, #212 plus its installer, SDK and documentation corrections), preserved unedited |
| 2 | #213 FileStore Windows replacement | `46c5be639b4d90cc554390004a0b09d46b2e3636` | Lane A | `src/storage.js` and `test/file-store-replace.test.js`, byte-identical |
| 3 | #214 status-only reconciliation | `5414c2368dee996a2e079da72c195a1535879762` | Lane A | status increment; schema and fixture bytes unchanged |
| 4 | #221 owned-directory ACL, **source/test/guide only** | `6fa50220ca31b4419739598dd113b9c5f89fb248` | Lane B | `integrations/connector/store.ts`, `integrations/connector/private-directory-acl.test.ts`, `integrations/gates/WINDOWS-OWNED-DIRECTORY-ACL.md` as one binary-safe patch (sha256 `07a69d606b1af6c4db4a125b51c01b07ebe99375124d312db0781884cda9c7e8`); its older-base generated downloads are not imported |
| 5 | #223 dependency advisories (new, Lane A) | `lane-a/AUDIT-fast-uri-advisory` @`2567197487bbf0fc69f1cc870c217baca21f995e` merged; its own branch head `dceaac2` adds regenerated bundles | Lane A | `package.json` (one `undici` override) and `package-lock.json` (`fast-uri` 3.1.9, `undici` 7.30.1) only. **Separately identified and separately revertable.** Added because `npm audit` began failing on the baseline itself after new advisories (production `fast-uri` via `ajv`, development-only `undici` via `wrangler`/`miniflare`); without it every audit step of CI fails |

Merge commits for the baseline, #219, #213, #214 and #223; one commit for the #221 delta; one regeneration commit (below). Not replayed: every constituent PR inside #219, #192/#195 (already integrated via #199), earlier #220 heads, #191, #184.

**Regeneration.** The connector and OpenClaw bundles embed `fast-uri` through `ajv`, so the #223 lock change alters them. On the combined source: `node integrations/distribution/build-private-directory.mjs`, then `npm run build`, committed as `8d83dcd`; a further regeneration leaves `git status` empty. Nothing is hand-merged; #223's own branch carries its own regeneration on the baseline, and the two are reconciled by regeneration, not by copying.

## 2. Exact delta from the reviewed `70a7ce9`

`git diff --stat 70a7ce9 8d83dcd`: the six #222 paths above, `package.json` and `package-lock.json` (#223), and the three regenerated downloads (`web/downloads/envoi-connector.mjs`, `envoi-openclaw.mjs`, `release.json`). No client source, installer, SDK, ACL or server-store byte changed from the reviewed candidate; the earlier 98-path delta against integration `d05498d` is, against `48e40e5`, the same candidate-only paths plus #223 and the regenerated bundles.

## 3. Generated artifacts (regeneration parity verified)

| File | SHA-256 | Bytes |
| --- | --- | --- |
| `integrations/distribution/private-directory.mjs` | `a74ff46ef8dfe42560de9d48d5acfb20ed6483e4cf01b1a08ddb2ee336c960f4` | 3923 (unchanged: it does not bundle `fast-uri`) |
| `web/downloads/envoi-connector.mjs` | `4d36fb2c94f2be3333c9555fb42a2667d9026a5f9efebaaee36fe37e14272a22` | 473036 |
| `web/downloads/envoi-openclaw.mjs` | `996adb5126622cb5d05e358d5b5df870b4955dffd2dbad84f1360290d652a80d` | 389675 |

The standalone-helper drift guard passes. The two downloads differ from the previously reviewed hashes (`25e7df85…` and `9582d743…`) only because of the patched `fast-uri` embedded through `ajv`.

## 4. Windows results at the checked source `8d83dcd0b478177a2fef33553752d47f5b117302`

PowerShell 5.1.26100.9711, Node v22.15.0, `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` explicitly false, no database variables, a fresh real `npm ci` (not a junction) on the new lock, sequential runs, native `C:\Windows\system32\whoami.exe` throughout. For `npm test` only, `C:\Program Files\Git\bin` was prepended in a child process (child `whoami` stayed native; `Git\usr\bin` unused) and the parent PATH was verified restored. No skip, retry, timeout, assertion or ACL change, no elevation, no volume move.

| Check | Result |
| --- | --- |
| C: checkout (`…\Temp\envoi-cand-8d83dcd`): #221 ACL regressions, native Windows helper, unchanged `portable-rest-runtime.test.ts`, distribution | 7 files, 75 pass, 0 fail, 3 POSIX-only skips |
| D: checkout: the same focused set | 75 pass, 3 skips |
| D: #222 durable-object lifecycle and deployment guard | 5/5 |
| D: #213 held-reader recovery/exhaustion, rollback, outbox accounting, with a3 held-work, consumer isolation, http-wake, storage/outbox/delivery | 72 tests, 56 pass, 0 fail, 16 PostgreSQL-only skips |
| `npm run typecheck` | PASS |
| `npm test` (full Windows backend) | 810 tests, **776 pass, 0 fail**, 34 PostgreSQL-only skips |
| scanner / stress-local | 14/14 / PASS |
| frontend / TypeScript SDK / Python SDK | 509/509 / 550/550 / 8/8 |
| `npm run test:integrations`, **complete suite on D:** | 987 tests, **983 pass, 0 fail**, 4 skips (existing `real-assets.test.ts` skip and three POSIX-only distribution tests) |
| `npm run cf:check` | PASS (14/14 tests, three dry runs, nothing deployed) |
| `npm audit --omit=dev` / `npm audit --audit-level=high` | 0 / 0 vulnerabilities |
| `npm run build` twice plus the generator, then `git status` | clean |
| `git diff --check` | clean |

An earlier full run at `180f305` (lock change composed, bundles not yet regenerated) also passed its tests but is **not** credited for this head: the regeneration changed the bundles, so the whole suite above was repeated at `8d83dcd`.

## 5. Resolved history kept visible

- At `676a904`: `npm test` 4 failures, all `test/ci-start-postgres.test.js` (WSL `bash.exe` first on PATH; 4/4 with Git's `bin` in the child env) and D: integrations 2 failures in `portable-rest-runtime.test.ts` (`SetOwner` without `WRITE_OWNER` on a Modify-only volume, REQUEST lane-b 6373593962), fixed by #221. A first rerun wrongly blamed PATH/`whoami` and was corrected.
- At `adaa0f1` and on the baseline `48e40e5` itself: both `npm audit` steps failed after new advisories were published (`fast-uri` moderate, production; `undici` high, development-only); resolved by #223. CI on PR heads that merge with the baseline (for example #217 run 40128100998) failed only that step.

## 6. Rollback (preserves the integrated #222 baseline, `d05498d` authorization/P0/WorkOS)

Never reset to an older input branch and never remove #222: revert, independently, the regeneration commit together with the #223 merge (restores the previous lock, which fails the audit step today), or the #221 delta commit (restores only the known Modify-only-volume failure, never a weaker ACL), or #213 then #214 (server), or the #219 merge (client), then run `node integrations/distribution/build-private-directory.mjs` and `npm run build`. Equivalently, integration itself is rolled back only by the human, to `48e40e5` or earlier. No flag, schema or storage change; source rollback only; no Worker, image or settings rollback executed.

## 7. Remaining

Exact-head CI for the PR head (PostgreSQL, production container and fail-closed startup, generated equality, audits); independent incremental re-review of this head by Lane B; the human's separate integration decision for an exact head (and, separately, for #223), then Lane A's resulting-integration push CI. New contracts, hosts, providers and operational gates stay separate, and historical accepted B/C credit is retained.
