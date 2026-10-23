# Provider contract re-review

Lane B, 2026-10-23. Evidence branch `lane-b/B-C-contract-consumer-review`, isolated owned worktree `provider-contract-review`. Baseline `d05498d8dc13c6f07dc151da7a41a1619ff62436`. Review-only; no dependent production implementation or provider/account operation.

## Current publications and verdicts

| PR | Exact publication | Result |
| --- | --- | --- |
| #215 mcp-wake v1 | `32975892945718296a4968a3d6ddbc40ef6d175b` | [Lane B ACK6373782280](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782280); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183) remains credited. |
| #216 provider-event-wake v1 revision2 | `1eee73a8cb08aefbad1469b097dd44bf49a1f073` | E1-E3 technical consumers pass. ACK withheld pending [decision-prose correction6374385811](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374385811). |
| #217 provider-gateway-native v1 revision2 | `b785836f2fb2e2874e4a317c12fd5a0346feada5` | [MISMATCH6375143615](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375143615), second review round. G1/G2 timeline corrections required; G3 byte guards pass. |
| #218 provider-connector-tools v1 | `3af8669a907c316b95ff92fa7031a50a654e1a18` | [Lane B ACK6373782839](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373782839); [human approval6374090183](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374090183), optionA, remains credited. |

The exact-publication author CI is terminal SUCCESS for [#216 run40020315648](https://github.com/rachelgonsalves821/Envoi/actions/runs/40020315648) and [#217 run40019951629](https://github.com/rachelgonsalves821/Envoi/actions/runs/40019951629), 26/26 steps each. CI is evidence at those publications, not approval or proof of actual provider capability.

## Independent execution

From owned detached review worktrees pinned to the two heads, on Windows PowerShell with Node22.15.0:

- #216: `node --test test/contract-fixtures.test.js test/contract-provider-event-wake.test.js`: 20/20 pass, no skips.
- #217: `node --test test/contract-fixtures.test.js test/contract-provider-gateway-native.test.js`: 18/18 pass, no skips.
- Lane B offline consumer: 121 canonical fixtures read directly from exact Git objects, inventories22/49/44/6; 22 positive groups pass, zero network calls. Exit2 records three findings: #216 known prose defect, #217 G1 causal clock and G2 expired-run recovery contradictions. No canonical fixture copies or changes are committed.

The initial consumer run had three harness failures, corrected before attributing any contract finding: it required a destination *recheck* marker on the first subscription instead of only cached renewals; it required receiver clocks on error-delivery cases and used two incorrect retry fixture IDs; and it incorrectly expected the ASCII4097 case to pass the schema's coarse character guard. The corrected assertions preserve the meaningful checks: cached-renewal destination validation, receiver freshness for successful deliveries, all signing/event causality, exact retry identity and delay, plus schema-valid multibyte overflow requiring a separate byte guard. This was a harness correction, not a server failure or a weakened contract requirement.

### #216 E1-E3 and remaining prose defect

E1 closed subscribe/unsubscribe shapes include delivery.mode, no-mode negative consumption fails, and idempotent unsubscribe returns the empty result. E2 covers principal/URL/secret isolation, TTL/rotation/binding invalidation, rerun destination validation and private-address refusal. E3 verifies exact-byte HMAC independently from causal signing/receiver clocks, unchanged signed stale replay, future timestamps, 300/301-second bounds, stable event identity and fresh retry signatures after Retry-After.

Official sources retrieved for this re-review: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) and [Grok webhook triggers](https://docs.x.ai/grok/automations/webhooks). These establish the public protocol basis, not account/workspace enablement or an operational Grok claim route.

At [handoffs decision section](https://github.com/rachelgonsalves821/Envoi/blob/1eee73a8cb08aefbad1469b097dd44bf49a1f073/docs/architecture/agent-native-v2/handoffs.md#L5105), decision2 is duplicated and spliced into the encrypted whsec custody choice; cache choice2a is separate. Section2 item7 still describes encrypted custody. Restore distinct complete allowlist, bounded-cache and encrypted-custody decisions, reconcile stale fixture counts, publish the corrected exact head and recheck it before ACK. Existing request6374385811 remains authoritative; no duplicate policy decision or approval requested.

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

Exact Git publication objects and existing lockfile dependencies are required. Fetch objects into an owned worktree; never run repository work in the primary human checkout. Optional ENVOI_EVENT_CONTRACT_SHA and ENVOI_GATEWAY_CONTRACT_SHA accept exact40-hex replacements for a corrected publication with the same fixture inventory; update/review counts explicitly if fixtures change. Exit0 means no findings, exit1 a failed positive assertion, exit2 semantic findings. Current result is exit2,22/22 positive groups,3 findings.

[CLAIM6374973855](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374973855) owns only this consumer and report. Lane A owns all contract, canonical fixture, root test and handoff changes. After corrected publications: exact-head re-review and CI, then ACK, then human approval. L3 permits at most three MISMATCH rounds before BLOCKED for human decision. This #217 result is round2; no automatic escalation or premature implementation.

## #220 composition review status

At this re-review, published #220 remains8c0f67ee5a9c77a721e425d9dfe8386e514d6303, before #221 incorporation. It is not an updated-ready candidate. Existing #219 independent review [6375113984](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6375113984) and #221 source-fix READY [6374556107](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6374556107) remain credited at their own heads. No source or test receipt transfers automatically to a later composition.

Await Lane A's updated exact publication and combined checks. Review selected #219+#213+#214 once plus #221 source/test/guide once; regenerate the private-directory helper and web downloads from the combined source, preserve installer/SDK fixes, verify Windows C:/D: behavior and full-suite/exact-head CI evidence. Do not create another shared composition or edit Claude's branches. #216/#217 contracts remain outside it. No integration approval is issued here.

Both remote flags remain OFF. StageA and PhaseD remain outside this review. No merge, deploy, settings change, provider registration/submission, real-host/model or hosted/paid acceptance test was performed.
