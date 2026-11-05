# Focused inbox startup fix

Task B-INBOX-STARTUP-FOCUSED, Lane B. Base integration/agent-native d38469b62fd0e7da6cda12a9dbb75813a07b9b8c.

The current public beta observed during diagnosis served 049106a1eadfc0eaffdf8a7d19519289112c46e8. Its /app document was 1,761,102 bytes. One warm anonymous request had 260 ms TTFB; that is not an authenticated inbox benchmark or a cold-start claim.

## Change

- Read authentication configuration and current identity concurrently, retaining configuration even when identity is refused.
- Start a fresh saved-inbox snapshot alongside directory discovery. Only a matching modern requester, provider, workspace and sufficient authentication can bypass directory latency. Legacy responses still require directory membership.
- Reuse that fresh snapshot instead of requesting it again. A late directory result checks access but does not reset the selected inbox.
- Reuse #264's identifier-only, human-scoped agent cache to start known child reads early for a returning root workspace. Every provisional child still requires a fresh matching requester, parent and owner-agent snapshot before display. Names, addresses, credentials, grants and inbox content are not stored in this cache.
- Publish each ready child independently. Do not refetch the already selected inbox; prefer its current snapshot over any old child-view entry.

First visits without cached identifiers and legacy servers still need directory discovery. A truly slow inbox response cannot be displayed before its own authorization/data arrive. This change removes avoidable client waiting, not server/storage latency.

## Verification

PowerShell, Node 24.11.1: frontend 557 passed; TypeScript SDK 611 passed; integrations 1,483 passed / four existing skips; Python eight passed; typecheck and production build passed. The initial sandbox Vitest attempt failed in Vite's temporary cache before loading tests; identical tests passed with a dedicated temporary directory. No assertion, production timeout or skip was weakened. CI has not run for this unpublished candidate.

The synthetic fixture uses the actual mounted App, two disposable agent inboxes and loopback HTTP only: `node frontend/acceptance/inbox-startup-fixture.mjs`. No real account, messages, credentials, agent runtime or hosted setting is used.

With directory discovery delayed 5,000 ms and each snapshot delayed 100 ms, a returning root workspace started both remembered child reads together. The root response completed after 106 ms; the two child responses completed after 248/249 ms from the directory request start, while the directory completed after 5,006 ms. The browser displayed both Milo and Iris. These are controlled local response timings, not hosted paint percentiles. The first cache-populating visit still waited for discovery. Separate tests verify a ready sibling is published without waiting for a slow sibling, and cross-account/provider/MFA/malformed/wrong-inbox snapshots cannot be used as the fast path.

## Existing work and integration

PR #280 at b356ba052f68122f76fc0778df60b00c92ff22df remains the separate screen-navigation/history fix. Its backend/startup changes were intentionally excluded. Combine source carefully, preserve its URL inbox/section selection and cancellation coordinator, and regenerate web/index.html. This startup candidate does not itself change document routing or fix every inbox-switch blank screen.

Only the agent-inbox-cache module and its original two tests are reused from frozen #264 at df01e525cfc7a76502eb353f2fb1d3bea43431a1. Do not merge #264 wholesale: its server, settings, asset splitting and navigation changes are not carried. Its newer #272 agent-cap exception is not carried. Backend, Worker, root configuration, canonical fixtures and handoffs remain untouched.

GitHub's connector refused the coordination write with 403. The browser submission was then rejected by automatic approval review for lacking explicit authorization to publish publicly. No bypass, public claim, push, PR creation, merge, deployment or settings change has occurred for this task. The local patch is ready for explicit publication approval; exact-head CI and hosted verification remain pending. Rollback is a revert of this task's source/generated commit while preserving #280 and other owners' work.
