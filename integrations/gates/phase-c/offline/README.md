# Phase C offline operator compatibility

From PowerShell on Node 24, after `npm ci`:

```powershell
node integrations/gates/phase-c/offline/check.mjs
```

On the operator's machine, add `--kit-root <absolute path to approved-continuation-v4>` to the **same command**. This verifies the assembled packet, SDK package and every source excerpt against the selected v4 bytes, then runs the original 65 tests on pinned disposable copies. Network and native-pipe connections are blocked before their imports; no file is executed in the original kit's directories. The command exits nonzero and prints the failing check/test with its reason. `SOURCE_CHANGED`, `V4_FILE_CHANGED` or `SELECTED_PACKET_CHANGED` requires a fresh source review and an explicitly refreshed snapshot; do not bypass the pin.

The portable command runs the committed public v4 excerpts and production SDK against actual loopback server routes with fresh disposable FileStore state. It runs Vitest with two workers to reduce startup contention. It reuses the existing SDK/runtime regressions rather than copying their mocks into a new suite. CI runs the new `*.test.ts` files through the existing integrations runner and the reused SDK tests through its existing runner. No workflow or root package change is needed.

## Incident coverage

The incident is [board #34, November 3](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6610537334). Test names carry incident numbers. Each old-behavior fault is confined to disposable files, an injected excerpt, or a rejected old assertion; the original operator files remain untouched.

| Incident | Test and old-failure demonstration | Actual implementation exercised |
| --- | --- | --- |
| 1. Gateway selection | [SDK compatibility](sdk-compatibility.test.ts), `incident 1`: old cached connection assertion fails, v4 reads the real selection write | `reselectHermesGateway`, `selectScopedHermes`, atomic `hermes-scoped.json` v2; enrollment/journal/accepted/ledger sentinels unchanged |
| 2. Hermes identity | SDK compatibility, `incident 2`: non-normalized old path fails; normalized path matches on both OS families | `hermesHost`, `hermesProfileIdentity`, `hermesJournalMatches`; no native connection |
| 3. Finalization fields | [Server compatibility](server-compatibility.test.ts), assembled decision tests: old `session.workId` assertion fails on the actual end response | SDK mint/parse/end and real `/session/end` handler; v4 joins retained work binding to returned session ID; wrong binding refuses |
| 4. OpenClaw pre-native scope | SDK compatibility, `incident 4`: injected unconditional old capture fails for absent native target | Exact composed v4 `beforeFirstScopedSnapshot` callback; pre-native observation retained, only reviewed native flows bind targets; existing receiver/control tests exercise SDK capture |
| 5. Oldest-first claims | Server compatibility, both proposal arrival orders plus `old fixed order refuses` | Exact v4 decision sequence/conductor sort against actual canonical claim handler across two cases; fixed old sequence fails at the returned work ID |
| 6. Decline retry | Server compatibility: old immediate claim cannot provide declined work; actual v4 pause then resumes it | Real retryable `HANDLER_FAILED`, persisted retry deadline, actual idle claim/hint, then SDK processing after v4 wait; clock boundary advances elapsed time |
| 7. Fixture expiry/order | Server compatibility: injected old 240-second bound receives real owner-action refusal after two 120-second turns and 30-second review; corrected 360-second bound fits | Actual policy-evaluation/request-human/decline handlers and signed binding; actual expired scoped decide returns `AUTHORITY_EXPIRED`; operation trace forbids operational decide, replacement evaluation/send/action fallback |
| 8. Decline instruction/no action | SDK compatibility, `incident 8`: old ambiguous text fails the target-only instruction requirement. Server compatibility rejects altered case state | Exact v4 owner announcement, production declined-flow policy, actual declined snapshot through SDK channel, processed receiving work, unchanged canonical case/messages and open `inProgress` state |

`sdk-compatibility` also executes the exact launcher failure/cleanup wrapper, including simultaneous initiating and cleanup failures: cleanup runs once and the first error remains the initiating error. The original exceptions are retained in order in the operator's `AggregateError`.

## Reused coverage and audit

The v4 tests were inspected before adding these seams. Its FIFO tests use handwritten rows, finalization uses a handwritten end body, pre-native coverage tests a predicate, and its host-identity test is Windows-only and accepts any non-identity connection error. Its schedule test returns a mocked claim order. The new tests connect those specific boundaries to the actual producer or route. The original assembly is also reproduced from its 12 test files, 43 JavaScript modules and one restoration helper. Its three historical support inputs are copied privately using hashes and paths recovered from the pinned code; their contents and identifiers are excluded from the committed manifest. The original Windows restoration test operates only on its temporary fixture files.

On Windows the original suite requires 65 passes and zero skips. Other systems retain its three existing Windows-only gates; the new portable identity/SDK tests always run. The two separate native-wrapper tests are excluded because they read real profile metadata. The selected 65-test closure has no actual runtime startup. A regression verifies the transport guard using invalid arguments, which cannot connect even if the guard breaks. The child environment is allowlisted, and its temporary directory stays inside the disposable tree so a forced timeout also cleans fixture artifacts. Failed private diagnostics remain in a separate temporary report; the copied code/data tree is removed after success or failure.

The command also runs existing tests in:

- `integrations/hermes/{scoped-runtime,reselect,continuation-receiver,continuation-receiver-batch}.test.ts`: native parsing/protocol refusal, wrong recipient/scope, duplicate and stale dispatch, authoritative native deadline/owner/pause cancellation, cleanup, terminal evidence and journal preservation.
- `sdk/typescript/test/{case-session,case-session-work}.test.ts`: strict server response parsing, malformed and unknown errors, lifecycle invalidation, retired lease refusal, late-result cancellation, initiating handler failure and channel-end-before-failure cleanup.

All newly introduced server transport is restricted to its disposable loopback origin. Child environment variables are allowlisted; database/provider/email/credential settings are not inherited. Clock changes and synthetic record timestamps are the only server-side injections. Provider inference is an inert completed no-action boundary. No real enrollment, accepted send, task journal or ledger path is opened for writing. Temporary data and the local child are removed after failures as well as success.

## Selected references

- Client: `5b4d7c2941be4052564f12d02c4d5f304af76ffc` (selected client; the exercised SDK implementations are unchanged on the current base).
- Current integration base: `d38469b62fd0e7da6cda12a9dbb75813a07b9b8c`.
- Selected server: `d98b4d9d6941ab267a2f0f120db891ddababad6e`.
- v4 packet SHA-256: `a7c64dc7f7b0730cf2b8efa89ec496f5768727faf5b8823d8d1d7cb7306076f5`.
- SDK operator package SHA-256: `a9784135e825265cf94d675aef2dcf5b3e97cb0e721e589649e8e05a940966ec`.
- [Production references](production-source.json): fifteen SDK/server implementation files, their selected source and SHA-256 after CRLF→LF normalization only. Fourteen are byte-identical to the selected implementations. `src/server.js` additionally permits one exact current-base hash after reviewing its deployment-identity import and staging agent-slot configuration changes; its case handlers are unchanged. The command is tested with both server sources. Other server files differ between the complete releases; this does not claim complete release-tree equality.
- [v4 excerpts](v4-source.json): original module byte hashes, exact source strings, source lines, delimiter ranges and excerpt hashes. The sole syntax adaptation is wrapping class methods/blocks for injected boundaries and removing `export`. Full private operator modules, packets and historical task data are excluded.
- [Original assembly references](assembly-source.json): code filenames/hashes and opaque private-support input hashes only. Executable/data contents stay outside the repository and CI fixtures.

## Limits

Passing establishes offline compatibility of the documented operator seams. It does **not** declare Phase C passed, authorize a new interval, validate real Hermes/OpenClaw startup or inference, validate hosted inventory/permissions/queues, or adopt v4 into the operator's live kit. There are no hosted, provider, browser, staging, deployment or merge operations. Native process allocation, owner observations and final private preservation joins retain their separate acceptance requirements.

The simulated 30-second human review demonstrates that v4 fits the documented operation order within its fixed bounds; it cannot guarantee a person's response time. A slow review or a different retry configuration must still refuse. The exact fixed-window guard and production timeout values are preserved.
