# Phase B/C client integration candidate

Task `B-C-CLIENT-INTEGRATION-READY`, Lane B, 2026-10-23. Base: `d05498d8dc13c6f07dc151da7a41a1619ff62436` on `integration/agent-native`. This candidate preserves approved #203/#173 authorization and the existing P0/WorkOS behavior. Phase D belongs to Rachel and is excluded.

## Source selection

Each row contributes only its Lane B source delta relative to the stated source base. Original writer branches and PRs remain unchanged. Imported `web/**` files are excluded; `npm run build` regenerates the combined candidate's downloads, release metadata and HTML.

| Input PR | Source base | Selected head |
| --- | --- | --- |
| #206 | `244c117fb2a00d6bdc95a991f9021a1fdb94b262` | `e0d0e9fc8052acbca66ddd2be7be14a6f3a571b2` |
| #183 | `cf3e39df6ca056f175f6504d626018ca851bc8fd` | `3c21f3bdc1e801045432de45ff06f7f678a1d07b` |
| #196 | `2312734c4e93c533d3e457929d0afc67b62fc130` | `7ec6c1ec132f0c454b313821512e9be4e049c6ea` |
| #193 | `bbd361ea52aab80fc53c402130a35718f6bee561` | `069355775bdc0ddfefb95ec1d53f1c11e32f8b8c` |
| #210 | `d05498d8dc13c6f07dc151da7a41a1619ff62436` | `9fa5c50c6de6252510098af4d52035de81401353` |
| #207 | `7d2c8633183f1e423c662be49c2262047b8ac6d4` | `aab146b6f5392ebb425bd6687b6623e8e3b99bb3` |
| #209 | `97212c8d17ea3ddace008b6fd630a31f5e8f0d46` | `39c625102ccefe326755220d2145488047500561` |
| #119 | `984051fe09092ddbd71039908ee15f8d4b7b8e4f` | `4776200d2d87a3a80af1469cbdd250d04ccdb869` |
| #212 | `d05498d8dc13c6f07dc151da7a41a1619ff62436` | `bb64e91c5b40603e55b40569f3132b85db36c214` |

Select #206 once: it carries #179/#190/#182/#204 and inherited #181 REST work. Select #119 once: it carries #111/#117 private-install prerequisites. Do not separately replay those increments or already integrated #174/#192/#195/#197. #212 is the dated audit snapshot, not another implementation dependency. Open original PR copies do not prove missing implementation.

The source deltas are the portable REST trusted-process adapter and host preparation; on-demand owner presence; offline host OAuth authorization planner; artifact preflight; Windows connector session replacement; Python/TypeScript offline quickstarts; private distribution/launchers; and status guides. No server, root configuration, canonical fixture or handoff changes are included.

## Corrections made in this candidate

- Python's normal quickstart no longer presents legacy inbox acknowledgement as native completion. The strict synthetic `native_acknowledgement_refused` example returns HTTP 410 and directs native work to the trusted fenced connector. Python does not acquire a new native lifecycle implementation.
- TypeScript documentation describes the implemented `CaseToolsClient`, stable-code connector lifecycle and current scoped case/asset flow; the documented focused command selects the SDK runner. The retained legacy owner-code example is identified explicitly.
- Onboarding/distribution guidance records integrated authorization and historical acceptance, retains `published: false`, and distinguishes preparation from a newly accepted route. No runtime capability is inferred from a provider name, skill or open browser.
- The private installer now accepts the actual combined build's exact optional `envoi-rest-host.mjs` in addition to its two required artifacts, verifies all declared hashes/sizes and preserves old two-artifact packages. Unknown artifact names remain refused. Required names are compared individually, so a comma-containing filename cannot masquerade as the required set; a negative regression covers this. A new regression packages and installs the third artifact and rejects tampering before destination creation.
- Private distribution's committed LF bundle and its strict drift guard are unchanged. Regenerating with `node integrations/distribution/build-private-directory.mjs` repaired a local CRLF checkout artifact produced during source assembly. Existing `.gitattributes` already enforces LF; no assertion or equality rule was weakened.

## Compatibility and remaining boundaries

Consumes the previously approved registration v1 revision 5, remote-auth v1 revision 4/Policy B, on-demand presence v1, case-session/case-tools, http-wake and lifecycle contracts. Both remote-auth flags remain OFF. A pure OAuth planner is not a token exchange client. Private installers and inert background planning do not authorize public publication or actual service execution. The private package supports explicit-path launchers; public provenance and operational upgrade/rollback remain separate decisions.

Claude's server FileStore draft #213 at `46c5be639b4d90cc554390004a0b09d46b2e3636` is a separate Lane A fix for REQUEST 6371465990. Its server files are not copied into this Lane B delta. The integrator must select/review that fix separately and run the full suite on the resulting combined SHA. Linux CI on this client candidate cannot clear the known Windows server held-reader issue.

Newly published #215 `mcp-wake`, #216 `provider-event-wake`, #217 `provider-gateway-native` and #218 `provider-connector-tools` require their own exact-publication client review and human decisions. This candidate adds no implementation for those packages and does not claim their approval. Previously approved contracts remain credited.

Historical Hermes/OpenClaw B-local 21/21 at `e8a958f` and human B/C countersign [6330847176](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330847176) are preserved. Artifact preflight does not replace installed-host execution. New provider/host execution, production cutover and publication remain with their respective owners and authorization. See [earlier closeout audit](B-C-CLOSEOUT.md) for the remaining operational evidence boundaries.

## Validation

Windows PowerShell, Node 22.15.0, Python 3.11.9:

- Full frontend: 509/509. TypeScript SDK: 550/550. Python: 8/8.
- Full integrations after the installer correction: 979 passed, 4 platform/existing skips (983 total; before the final artifact-name regression); no failed test. Final distribution focused: 67 passed, 3 platform skips.
- Explicit Node authorization/REST consumer tests: 10/10; distribution and SDK-example typechecks passed.
- `npm run build` passed all typechecks and generated the combined web/downloads plus the private helper/REST bundle. Private bundle drift guard passed unchanged.
- Actual freshly built three-artifact manifest successfully prepared and installed in a disposable private directory. No helper, enrollment, runtime or service was invoked. Unknown artifact names remain rejected by existing tests; the new third-artifact test proves byte preservation and tampering refusal.
- One initial SDK offline-delivery local-server test hit its unchanged 30-second timeout while client suites ran concurrently. The complete unchanged SDK suite then passed separately (550/550). The first complete integrations run passed 978 with 4 skips; the final 979 count includes the added installer regression.
- A CRLF checkout artifact initially caused five strict private-bundle comparisons to fail; regeneration restored the committed LF bytes. The existing LF attributes and assertions were retained. Neither this observation nor a Linux CI pass clears the separate server FileStore issue.

Exact-head CI and the Windows backend result are recorded in the draft PR and build-board receipt. PostgreSQL/container checks are delegated to the existing CI workflow. Source inclusion and synthetic/disposable-directory tests are not new hosted acceptance claims.

## Integration and rollback

Only the human approves integration; Lane A performs it under the repository protocol. This is a draft client candidate into `integration/agent-native`, not an integration-branch update. Review this candidate's own source delta and exact-head CI. Select its inputs once rather than additionally merging their original PRs. Pair any separately selected Lane A FileStore fix with resulting-SHA checks.

Rollback reverts only this candidate's Lane B source/build delta while preserving `d05498d` authorization, P0 and WorkOS. Do not reset integration to an old input branch. Operational rollback, private installed profiles and hosted evidence need their own exact-release records.
