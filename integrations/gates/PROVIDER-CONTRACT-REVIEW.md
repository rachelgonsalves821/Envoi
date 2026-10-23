# Provider contract re-review

Lane B, 2026-10-23. Evidence branch `lane-b/B-C-contract-consumer-review`, isolated owned worktree `provider-contract-review`. Baseline `d05498d8dc13c6f07dc151da7a41a1619ff62436`. Review-only; no dependent production implementation or provider/account operation.

## Current publications and verdicts

| PR | Exact publication | Result |
| --- | --- | --- |
| #215 mcp-wake v1 | `32975892945718296a4968a3d6ddbc40ef6d175b` | [Lane B ACK6373782280](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782280); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183) remains credited. |
| #216 provider-event-wake v1 revision2 | `d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b` | [CONTRACT-ACK6375518478](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375518478). E1-E3 and the final decision-prose correction pass. Human exact-head approval remains separate. |
| #217 provider-gateway-native v1 revision2 | `b785836f2fb2e2874e4a317c12fd5a0346feada5` | [MISMATCH6375143615](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375143615), second review round. G1/G2 timeline corrections required; G3 byte guards pass. |
| #218 provider-connector-tools v1 | `3af8669a907c316b95ff92fa7031a50a654e1a18` | [Lane B ACK6373782839](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782839); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183), optionA, remains credited. |

The exact-publication author CI is terminal SUCCESS for [#216 run40028127612](https://github.com/rachelgonsalves821/Envoi/actions/runs/40028127612) and [#217 run40019951629](https://github.com/rachelgonsalves821/Envoi/actions/runs/40019951629), 26/26 steps each. CI is evidence at those publications, not approval or proof of actual provider capability.

## Independent execution

From owned detached review worktrees pinned to the two heads, on Windows PowerShell with Node22.15.0:

- #216: `node --test test/contract-fixtures.test.js test/contract-provider-event-wake.test.js`: 20/20 pass, no skips.
- #217: `node --test test/contract-fixtures.test.js test/contract-provider-gateway-native.test.js`: 18/18 pass, no skips.
- Lane B offline consumer: 121 canonical fixtures read directly from exact Git objects, inventories22/49/44/6; 22 positive groups pass, zero network calls. Exit2 now records only the two #217 G1/G2 contradictions; no remaining #216 finding. #216 was re-executed at d920f65,20/20; the prior #217 semantic review remains pinned to b785836. Its later655c5ff changes only the informative count, not the inconsistent fixtures, and does not add a review round. No canonical fixture copies or changes are committed.

The initial consumer run had three harness failures, corrected before attributing any contract finding: it required a destination *recheck* marker on the first subscription instead of only cached renewals; it required receiver clocks on error-delivery cases and used two incorrect retry fixture IDs; and it incorrectly expected the ASCII4097 case to pass the schema's coarse character guard. The corrected assertions preserve the meaningful checks: cached-renewal destination validation, receiver freshness for successful deliveries, all signing/event causality, exact retry identity and delay, plus schema-valid multibyte overflow requiring a separate byte guard. This was a harness correction, not a server failure or a weakened contract requirement.

### #216 E1-E3 and final prose correction: ACK

E1 closed subscribe/unsubscribe shapes include delivery.mode, no-mode negative consumption fails, and idempotent unsubscribe returns the empty result. E2 covers principal/URL/secret isolation, TTL/rotation/binding invalidation, rerun destination validation and private-address refusal. E3 verifies exact-byte HMAC independently from causal signing/receiver clocks, unchanged signed stale replay, future timestamps, 300/301-second bounds, stable event identity and fresh retry signatures after Retry-After.

Official sources retrieved for this re-review: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) and [Grok webhook triggers](https://docs.x.ai/grok/automations/webhooks). These establish the public protocol basis, not account/workspace enablement or an operational Grok claim route.

Final publication d920f65 changes handoffs.md only from1eee73a. It restores distinct complete allowlist, encrypted supplied-HMAC-secret custody and bounded-cache choices, renumbers1-6, and reconciles the informative fixture count49. Custody matches section2.7/x-secret; canonical schema,49 fixtures and tests are unchanged. Known request6374385811 is resolved. Own final-head Windows contract suite20/20 and independent consumers pass. CI40028127612 at d920f65 is SUCCESS26/26, actual logs backend770pass/34gated skips/0fail, PostgreSQL325/325 with no skips, scanner14, both audits0 and all client/build/generated/config/container checks green.

[CONTRACT-ACK6375518478](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375518478) is technical review, not human approval. The human may decide this exact publication's six choices; dependent implementation still waits for exact approval. D1-D3/G1-G4 and actual provider/closed-app/flag-on evidence remain open. No new policy or capability is inferred from green tests.

### #217 G1: repaired-session claim lease predates owner confirmation

Expected: a successful generation5 claim occurs after owner-confirmed activation and has a live lease then.

Observed: [repair-activate-native-scope.json:23](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/repair-activate-native-scope.json#L23) confirms the owner at 2026-10-24T12:05:00.000Z and bounds the new session from it. [claim-new-generation-ok.json:54](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/claim-new-generation-ok.json#L54) returns HTTP200 with leaseExpiresAt12:02:30, before authorization exists. Consent-model's later reply-sent reference still uses a generation4 fixture.

Request: controlled timestamps and executable owner-upgrade, old-cookie-refusal, unchanged pairing, owner confirmation, activation, existing inbox-CSRF acquisition, generation5 claim/action progression. Keep old-generation refusal and seven-day owner-confirmation bound. This is fixture causality, not a demand for a new route.

### #217 G2: expired lease replaced in an exhausted run

Expected: recovery obeys the existing120-second run bound, no duplicate item charge, canonical expiry attempt accounting and one queue.

Observed: [x-limits](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/schemas.json#L65) fixes lease150seconds/run120seconds. [claim-replay-after-lease-expiry.json](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/claim-replay-after-lease-expiry.json#L25) declares the outstanding lease expired yet returns newLease true under the same run_example. Full lease expiry necessarily occurs after that run's time budget. Handoff3.1 currently specifies this as a new claim without qualifying run expiry.

Request: runStartedAt/asOf, explicit ordering of run-budget and lease checks, old timed-out run refusal and fresh authorized run recovery after expiry. If a different bounded timing model is intended, specify and test it consistently. Preserve in-budget same-run/restart packet replay and next-item progression. Do not silently waive120seconds for retries.

G3 now passes ASCII4096/4097, four-byte text4096/4400, whole-request bounds and2048-byte summary truncation on code point boundaries. No new G3 finding. Reconcile the implementation-note fixture count30 vs44. No production-runtime failure is claimed.

## Reproduction and ownership

```powershell
$env:ENVOI_REMOTE_MCP_OAUTH='false'
$env:ENVOI_PROVIDER_CONNECTORS='false'
$env:ENVOI_CONTRACT_REVIEW_RESULT='integrations/gates/.runtime/provider-review-rev2.json'
node integrations/contract-fixtures/provider-contracts.review.mjs
```

Exact Git publication objects and existing lockfile dependencies are required. Fetch objects into an owned worktree; never run repository work in the primary human checkout. Optional ENVOI_EVENT_CONTRACT_SHA and ENVOI_GATEWAY_CONTRACT_SHA accept exact40-hex replacements for a corrected publication with the same fixture inventory; update/review counts explicitly if fixtures change. Exit0 means no findings, exit1 a failed positive assertion, exit2 semantic findings. Current result is exit2,22/22 positive groups,2 findings, both #217. The #216 default pin is now d920f65.

[CLAIM6374973855](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374973855) owns only this consumer and report. Lane A owns all contract, canonical fixture, root test and handoff changes. After corrected publications: exact-head re-review and CI, then ACK, then human approval. L3 permits at most three MISMATCH rounds before BLOCKED for human decision. This #217 result is round2; no automatic escalation or premature implementation.

## #220 composition review: technical ACK

Exact head70a7ce9da1ffb7207d3f20fe9ddb0f0a20ba33a3, baseline d05498d8dc13c6f07dc151da7a41a1619ff62436. [READY / independent technical ACK6375547270](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375547270). No blocking composition finding. Previous pre-#221 head8c0f67e is superseded; its D-drive failure is cleared for this exact corrected composition by independent execution below.

### Selected source and artifact preservation

Reviewed98 changed paths from baseline,16-path increment over #219@8c1721c. Baseline/#219/#213/#214 are ancestors. #213 server/storage regression blobs, all six #214 status paths and #221's store/test/guide match their reviewed publications byte-for-byte. The increment has no extra paths beyond these selections, regenerated helper/downloads and the composition manifest. Frontend/SDK equal #219; no root package/lockfile, deployment/worker/scanner/db or onboarding-flag delta. Canonical schemas and fixtures unchanged; registry only marks existing approved statuses. New contracts #215-#218 excluded.

Checked source818794e4ad5c66588fd76687206c832ad11adfe4 differs from PRhead70a7ce9 only in the composition guide. #219 installer/third-private-artifact/exact-name and SDK corrections remain; existing independent #219 review6375113984 is credited for unchanged source. Re-read #213 rename-only win32 bounded EPERM/EBUSY retry and rollback-all behavior, and #221 owner/current-SID protected DACL/foreign-owner refusal without SetOwner. No weakening introduced by composition.

| Combined artifact | SHA256 | Bytes |
| --- | --- | --- |
| private-directory.mjs | a74ff46ef8dfe42560de9d48d5acfb20ed6483e4cf01b1a08ddb2ee336c960f4 | 3923 |
| envoi-connector.mjs | 25e7df85444a71a564a43ddb4a50615b5939a70908119725917fa10a4a1ac1aa | 471761 |
| envoi-openclaw.mjs | 9582d7439ee295cc38bb1e411a0599a86bb5512931dba53e7ad3d6e5d4e629af | 388399 |

Hashes/lengths agree with the manifest, published blobs, regenerated files and release.json. Older-base #221 downloads were not imported.

### Independent final-candidate execution

Owned detached worktrees C:/Users/KAILASH/.codex/worktrees/composition220-review/Sinaloa and D:/vsc/NEU/envoi-lane-b-review-220, both exact70a7ce9. PowerShell7.6.5, Node22.15.0, native Windows whoami, both remote flags false, DATABASE_URL empty.

- C: ACL/native-helper/unchanged portable REST/distribution checks75pass,3POSIX-only skips (7 files).
- C: FileStore held-reader/retry/exhaustion/rollback, a3 held-work, consumer isolation, http-wake, storage transactions/outbox/delivery56pass,16PostgreSQL-only skips (72 tests).
- D: full integrations983pass,0fail,4skips (existing real-assets skip plus3POSIX-only distribution cases). Actual owned-directory ACL regressions execute on the D: checkout volume. Portable REST tests remain unchanged and pass. This is the published candidate, not the earlier uncommitted overlay.
- C: standalone helper regeneration plus npm run build (production typechecks included) pass, git status empty and git diff --exit-code clean. D: checkout clean; baseline diff --check clean.

Two initial review launch errors were corrected before product tests executed: a missing output-log directory and a misnamed Vitest config/path. Neither is attributed to product code; corrected commands above pass without source changes.

### CI and author evidence, explicitly attributed

[Exact-head CI40028051745](https://github.com/rachelgonsalves821/Envoi/actions/runs/40028051745), independently read: SUCCESS26/26 at70a7ce9. Linux backend767pass/38gated-or-platform skips/0fail; scanner14; frontend509; TS550; Python8; integrations977pass/10gated-or-platform skips; PostgreSQL325/325 zero skips; stress, generated equality, Cloudflare checks, actual production-container build and missing-configuration fail-closed startup green; both audits0.

The committed manifest/PR description records AUTHOR full Windows results at818794e: backend771pass/34skips, frontend509, TS550, Python8, integrations983/4; typecheck/scanner/stress/config/audits/build green. Its source relationship to70a7ce9 is independently verified above. This review supplements that full Windows evidence with own C: focused and D: full-integration executions; it does not claim a second independent run of every Windows command. Existing #219 review6375113984 and #221 source READY6374556107 remain correctly attributed.

The human's separate exact-head integration decision and subsequent resulting-integration checks/CI remain pending. No host/provider acceptance inferred, and no duplicate replay of #219 constituents or #221 generated artifacts is appropriate. Source rollback preserves d05498d authorization/P0/WorkOS and regenerates affected bundles. #216's contract ACK is separate; #217's pending correction does not enter this candidate. #222/P0 remains separate.

Both remote flags remain OFF. StageA and PhaseD remain outside this review. No merge, deployment, shared/integration/main update, settings change, provider registration/submission, real-host/model or hosted/paid acceptance test was performed.
