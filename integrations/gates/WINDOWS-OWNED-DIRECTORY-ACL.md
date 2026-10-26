# Owned Windows credential-directory ACL fix

> Historical checkpoint. Current approvals, implementation and remaining acceptance are recorded in [the B/C candidate report](../../docs/architecture/agent-native-v2/BC-IMPLEMENTATION-CANDIDATE.md).

Task B-C-owned-directory-ACL, Lane B. Responds to [REQUEST6373593962](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6373593962). Source base: integration/agent-native `d05498d8dc13c6f07dc151da7a41a1619ff62436`. This is one bounded follow-up, not another B/C composition or a replacement for #219/#220.

## Problem and change

An account may own a directory on a Modify-only volume without WRITE_OWNER. The owner can replace its DACL through implicit owner rights, but the old code also wrote the unchanged owner and Windows refused the whole security update. Ordinary C: temp-directory tests hid the failure reproduced by portable REST on D:.

The helper now reads and requires the existing owner to equal the current native Windows SID, writes only the protected DACL, and verifies the resulting owner and exact single non-inherited current-SID FullControl allow rule with container/object inheritance. A foreign owner is refused before any DACL write; ownership is never seized. Native helper resolution, canonical/symlink rejection, failure propagation, POSIX mode0700 and existing-child icacls resets remain. No elevation or weaker permissions are needed.

Source files: integrations/connector/store.ts and integrations/connector/private-directory-acl.test.ts. Affected web files are generated only by npm run build. No server, canonical contract, fixture, root configuration or existing test assertion/timeout changes.

## Reproduction and validation

The new Windows regression creates fixtures in the checkout volume, explicitly denies TakeOwnership while retaining Modify, proves a same-SID owner write fails without changing the descriptor, then requires successful privateDirectory protection. Separate cases refuse a foreign-owner comparison without changing descriptor/data and remove broad child grants without changing file contents. Another caller SID is simulated for the foreign-owner case; no real ownership transfer or elevation occurs.

Before the fix on D:, two of three new tests failed at privateDirectory; the foreign-owner refusal passed. After the fix, the three regressions plus existing native-helper tests pass6/6. Only newly created disposable fixtures have their ACLs changed; parents and real credential stores are untouched.

Local composed proof uses an OWNED checkout on D: pinned to #220 `8c0f67ee5a9c77a721e425d9dfe8386e514d6303`, plus exactly the two source/test files from this fix. That composition already contains #219+#213+#214 once. The unchanged portable-REST tests and distribution/native/ACL selection passed75 with3 platform skips. The dependent standalone private-directory.mjs was regenerated with its existing build-private-directory.mjs command; it must never be hand-patched. Full composed D: Lane B results: frontend509, TypeScript SDK550, Python8 and integrations983pass/4platform-existing skips (987total), including the unchanged portable-REST tests. Exact-head CI is recorded in this fix PR and its board receipt. The initial composition proof is an uncommitted validation overlay, not a new integration SHA or hosted gate.

## Integration and rollback

Lane A incorporates this source increment ONCE into the existing single candidate, preserving #219 corrections and #213/#214. Do not import this base branch's older generated web over #220. Rebuild the dependent private directory bundle with node integrations/distribution/build-private-directory.mjs, then run npm run build on the resulting source; generated files are not hand-merged. Run the unchanged D: portable-REST/full-integration checks and the full resulting-SHA gate before READY. Source-fix CI on its older integration base is not that resulting-SHA receipt.

A Windows pass is local filesystem evidence, not real-host/provider acceptance. Existing contract approvals are preserved, #216/#217 mismatches remain separate, both remote flags stay OFF and StageA/PhaseD remain unchanged. No merge, deployment, settings, provider or real-host operation is included.

Rollback reverts only this bounded source delta and regenerates its dependent artifacts, preserving approved authorization/P0/WorkOS and #219's client corrections. Reverting restores the known Modify-only-volume failure; do not weaken ACLs or move the failing tests to C: to hide it.
