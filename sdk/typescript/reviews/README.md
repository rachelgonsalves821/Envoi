# Published contract consumer reviews

Fixture-only reviews read canonical publishing-worktree files through ENVOI_CONTRACT_FIXTURES_ROOT. No Lane A files are copied/edited and no B-2/N1 production changes are included.

## a4-wake v1

Publication e9c00ac8df84dd8d62f62b940776ad7b782ee2e7 (PR #44): **37/37 pass**. The original PR #49 suite is carried forward and extended. All 26 fixtures consume and validate, including three existing SDK delta consumptions, fresh/reset baselines, ordinary control frames, and explicit publication-prose checks.

The prior stream-from-latest MISMATCH at 67df29d is resolved. Section 2 distinguishes processed-event advancement from saving ready.cursor as a starting baseline only for an inbox without a stored cursor or a reset after EVENT_CURSOR_INVALID. Ordinary no-ID control frames never advance it; a null baseline stays empty. The revised stream fixture instructions agree. CONTRACT-ACK is appropriate; human approval is still required.

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = '<e9c00ac checkout>/test/contract-fixtures'
npx vitest run --config vitest.a4-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

After approval, B-2 needs inbox-scoped cursors; SSE wake, single-flight claims and safety timers instead of periodic delta polling; delta gap recovery; invalid-cursor bootstrap; paused status recovery; relative hints; prescribed jitter/backoff and Retry-After bounds; terminal fences.

## envoi-names v1

Publication 2591063858ce6f706e2bc3ae55650de9d2a52fca (PR #50; head 5a9bde5 additionally merges the integration CI mirror change): **13/13 pass**. All eight fixtures consume and validate. The 19-tool mapping is complete and unique; the exact three-tool case-read allowlist is preserved; the producer list schema rejects old names. Existing SDK rotation accepts the 43/64-character Envoi tokens. Trusted MCP consumers preserve new tool lists and HTTP-200 JSON-RPC -32602 retired-name responses.

Actual SDK consumption of both old access and old MCP credential responses permits one refresh attempt on AUTHENTICATION_REQUIRED, receives REFRESH_TOKEN_INVALID for the retired refresh token, and durably enters NEEDS_RECONNECT. No enrollment is attempted; identity is preserved and further credential operations stop locally. This matches the overall owner-reconnect outcome and unchanged intermediate a3 policy.

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = '<2591063 checkout>/test/contract-fixtures'
npx vitest run --config vitest.names-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

CONTRACT-ACK is appropriate; coordinated cutover still waits for human approval. N1 client work covers TypeScript/Python package and exported names, all adapter tools/prompts, one-time state directory migration, service labels, and Envoi-only downloads. Lane A owns server/credential/schema/packaging changes; both lanes integrate together. The separately defined a3 v2 fixture publication requires its own review and approval. These ACKs cover fixture consumption and contract clarity, not future implementation.
