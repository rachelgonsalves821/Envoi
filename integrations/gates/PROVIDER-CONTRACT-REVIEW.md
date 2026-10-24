# Provider contract re-review

Lane B, updated 2026-10-24. Evidence branch `lane-b/B-C-contract-consumer-review`, isolated owned worktree `provider-contract-review`. Baseline `d05498d8dc13c6f07dc151da7a41a1619ff62436`. Review-only; no dependent production implementation or provider/account operation.

## Current publications and verdicts

| PR | Exact publication | Result |
| --- | --- | --- |
| #215 mcp-wake v1 | `32975892945718296a4968a3d6ddbc40ef6d175b` | [Lane B ACK6373782280](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782280); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183) remains credited. |
| #216 provider-event-wake v1 revision2 | `d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b` | [CONTRACT-ACK6375518478](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375518478). E1-E3 and the final decision-prose correction pass. [Human exact-head contract approval6375805230](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375805230) is separately recorded; operational authority is not inferred. |
| #217 provider-gateway-native v1 revision2 | `9bca2380a51038cfe72fd9b247730afb080988ce` | All contract corrections pass; [final ACK blocked by own-head audit failure6389037650](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6389037650). |
| #218 provider-connector-tools v1 | `3af8669a907c316b95ff92fa7031a50a654e1a18` | [Lane B ACK6373782839](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782839); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183), optionA, remains credited. |

The #216 exact-head CI40028127612 remains SUCCESS26/26. The earlier #217 ddf8df0 CI40030128784 is historical green evidence only; current9bca238 [CI40128100998](https://github.com/rachelgonsalves821/Envoi/actions/runs/40128100998) is FAILURE at the production dependency audit. No old-head CI transfers to the new head. CI is not human approval or proof of provider capability.

## Independent execution

From owned detached review worktrees pinned to the two heads, on Windows PowerShell with Node22.15.0:

- #216: `node --test test/contract-fixtures.test.js test/contract-provider-event-wake.test.js`: 20/20 pass, no skips.
- #217: `node --test test/contract-fixtures.test.js test/contract-provider-gateway-native.test.js`: current9bca23820/20 pass, no skips (earlier18/18 retained as historical evidence).
- Lane B offline consumer: 128 canonical fixtures read directly from exact Git objects, inventories22/49/51/6; 24 positive groups pass, zero network calls. Current9bca238 consumer exits0:24/24 groups, zero findings and zero network calls. The separate decision-cost prose defect and earlier G1/G2 contradictions are resolved. Prior executions below remain explicitly historical.

The initial consumer run had three harness failures, corrected before attributing any contract finding: it required a destination *recheck* marker on the first subscription instead of only cached renewals; it required receiver clocks on error-delivery cases and used two incorrect retry fixture IDs; and it incorrectly expected the ASCII4097 case to pass the schema's coarse character guard. The corrected assertions preserve the meaningful checks: cached-renewal destination validation, receiver freshness for successful deliveries, all signing/event causality, exact retry identity and delay, plus schema-valid multibyte overflow requiring a separate byte guard. This was a harness correction, not a server failure or a weakened contract requirement.

### #216 E1-E3 and final prose correction: ACK

E1 closed subscribe/unsubscribe shapes include delivery.mode, no-mode negative consumption fails, and idempotent unsubscribe returns the empty result. E2 covers principal/URL/secret isolation, TTL/rotation/binding invalidation, rerun destination validation and private-address refusal. E3 verifies exact-byte HMAC independently from causal signing/receiver clocks, unchanged signed stale replay, future timestamps, 300/301-second bounds, stable event identity and fresh retry signatures after Retry-After.

Official sources retrieved for this re-review: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) and [Grok webhook triggers](https://docs.x.ai/grok/automations/webhooks). These establish the public protocol basis, not account/workspace enablement or an operational Grok claim route.

Final publication d920f65 changes handoffs.md only from1eee73a. It restores distinct complete allowlist, encrypted supplied-HMAC-secret custody and bounded-cache choices, renumbers1-6, and reconciles the informative fixture count49. Custody matches section2.7/x-secret; canonical schema,49 fixtures and tests are unchanged. Known request6374385811 is resolved. Own final-head Windows contract suite20/20 and independent consumers pass. CI40028127612 at d920f65 is SUCCESS26/26, actual logs backend770pass/34gated skips/0fail, PostgreSQL325/325 with no skips, scanner14, both audits0 and all client/build/generated/config/container checks green.

[CONTRACT-ACK6375518478](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375518478) is technical review, not human approval. The human may decide this exact publication's six choices; dependent implementation still waits for exact approval. D1-D3/G1-G4 and actual provider/closed-app/flag-on evidence remain open. No new policy or capability is inferred from green tests.

### Historical #217 G1 at b785836: resolved at ddf8df0

Expected: a successful generation5 claim occurs after owner-confirmed activation and has a live lease then.

Observed: [repair-activate-native-scope.json:23](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/repair-activate-native-scope.json#L23) confirms the owner at 2026-10-24T12:05:00.000Z and bounds the new session from it. [claim-new-generation-ok.json:54](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/claim-new-generation-ok.json#L54) returns HTTP200 with leaseExpiresAt12:02:30, before authorization exists. Consent-model's later reply-sent reference still uses a generation4 fixture.

Request: controlled timestamps and executable owner-upgrade, old-cookie-refusal, unchanged pairing, owner confirmation, activation, existing inbox-CSRF acquisition, generation5 claim/action progression. Keep old-generation refusal and seven-day owner-confirmation bound. This is fixture causality, not a demand for a new route.

### Historical #217 G2 at b785836: resolved at ddf8df0

Expected: recovery obeys the existing120-second run bound, no duplicate item charge, canonical expiry attempt accounting and one queue.

Observed: [x-limits](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/schemas.json#L65) fixes lease150seconds/run120seconds. [claim-replay-after-lease-expiry.json](https://github.com/rachelgonsalves821/Envoi/blob/b785836f2fb2e2874e4a317c12fd5a0346feada5/test/contract-fixtures/provider-gateway-native/claim-replay-after-lease-expiry.json#L25) declares the outstanding lease expired yet returns newLease true under the same run_example. Full lease expiry necessarily occurs after that run's time budget. Handoff3.1 currently specifies this as a new claim without qualifying run expiry.

Request: runStartedAt/asOf, explicit ordering of run-budget and lease checks, old timed-out run refusal and fresh authorized run recovery after expiry. If a different bounded timing model is intended, specify and test it consistently. Preserve in-budget same-run/restart packet replay and next-item progression. Do not silently waive120seconds for retries.

G3 now passes ASCII4096/4097, four-byte text4096/4400, whole-request bounds and2048-byte summary truncation on code point boundaries. No new G3 finding. Reconcile the implementation-note fixture count30 vs44. No production-runtime failure is claimed.

## #217 final technical re-review at ddf8df0

[Lane A publication6375676660](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375676660), exact head ddf8df082e9cca33ce536d9a0e30a23afb58c7b8. Delta is contract-only (handoff, registry, own fixtures/schema/test); no Stage1 canonical contract, source, deployment or other approved contract change. Fixture inventory now51. New semantic controls are added to the existing read-only Git consumer, not canonical copies.

Own detached D: review-cw3 at ddf8df0, Windows PowerShell/Node22.15.0: generic+bespoke20/20, no skips. Independent consumer24/24 positive groups across128 fixtures, zero network calls. Existing groups preserve request/action/secret/byte-boundary, outstanding replay and budget accounting checks. Two new groups check the complete repair sequence and generation5 cookie/CSRF/claim/reply causality, explicit live lease and120-second budget controls (including negative and exact-boundary clocks), old-run refusal before its lease expiry, fresh-run idle/expiry recovery, min interval, item/attempt accounting and settled-idempotency replay without effects after expiry. Both original G1/G2 contradictions are resolved.

Exact-head CI40030128784 independently inspected: SUCCESS26/26 at ddf8df0, backend770pass/34gated skips/0fail; PostgreSQL325/325 no skips; scanner14; generated equality, actual production container and fail-closed startup and every required command green; both audits0.

One static decision-cost correction remains before ACK/human packet: [REQUEST6375726310](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375726310). Handoff section8 decision7 promises a maximum30-second wait after a run overruns. Its own valid fixtures contradict that explanation: run ends12:02:00; claim-next-item-after-settlement lease ends12:03:30 (90s later), renew-once lease ends12:04:30 (150s later). The normative rule of150seconds from the actual last claim/renewal is otherwise clear and passes. Request the explanatory sentence tie waiting to that actual lease expiry, up to150seconds after run end for an in-budget final claim/renewal. No policy change, timing relaxation, new route or wire/fixture MISMATCH round is requested. The offline consumer records this text counterexample separately from24 passing semantic groups; exit2 currently means this one prose finding. Await documentation-only exact publication and own CI, then recheck before ACK. Human approval remains separate.

## #217 decision-text correction verified; current CI blocker

At9bca2380a51038cfe72fd9b247730afb080988ce the sole delta fromddf8df0 is handoff decision7. It now correctly describes waiting until actual outstanding lease expiry and the90s/150s counterexamples. All51 canonical gateway fixtures, schema/tests, Stage1, runtime and root bytes are unchanged. REQUEST6375726310 is resolved. Own Windows PowerShell/Node22.15.0 generic+bespoke20/20, zero skips; independent offline24/24 groups on128 fixtures, zero findings/network calls, exit0. No additional contract correction or MISMATCH round.

[BLOCKED final ACK6389037650](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6389037650): actual exact-head [CI40128100998](https://github.com/rachelgonsalves821/Envoi/actions/runs/40128100998) failed `npm audit --omit=dev`, reporting one moderate fast-uri finding (four GHSA references in the failed log). Full audit step was skipped. Every preceding backend/client/build/generated/config/container/PostgreSQL step passed; overall CI remains red. No exploitability or Production impact conclusion is claimed. Existing Lane A dependency-owner [request6389021920](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6389021920) covers the bounded owner correction; no duplicate writer/root edit is introduced here. Final ACK waits for the appropriate corrected head and fresh green checks, without weakening or waiving the audit gate.

The current integration baseline is48e40e5 after the separately approved #222 integration. #220's earlier70a7ce9 technical ACK below remains head-specific; pending composition reconciliation/request6384667485 must preserve #222 once, obtain own-head checks and incremental review. No integration/main/author/shared branch or provider action is performed by this reviewer.

## Reproduction and ownership

```powershell
$env:ENVOI_REMOTE_MCP_OAUTH='false'
$env:ENVOI_PROVIDER_CONNECTORS='false'
$env:ENVOI_CONTRACT_REVIEW_RESULT='integrations/gates/.runtime/provider-review-rev2.json'
node integrations/contract-fixtures/provider-contracts.review.mjs
```

Exact Git publication objects and existing lockfile dependencies are required. Fetch objects into an owned worktree; never run repository work in the primary human checkout. Optional ENVOI_EVENT_CONTRACT_SHA and ENVOI_GATEWAY_CONTRACT_SHA accept exact40-hex replacements for a corrected publication with the same fixture inventory; update/review counts explicitly if fixtures change. Exit0 means no findings, exit1 a failed positive assertion, exit2 semantic findings. Current consumer result is exit0,24/24 positive groups,zero findings. Default pins are #216d920f65 and #2179bca238, with51 gateway fixtures. CI is separately red at the production dependency audit, so exit0 does not confer final ACK.

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
