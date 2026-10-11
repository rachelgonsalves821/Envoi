# N2 browser client and contract consumption

N2-server publication: `01764ca7fa38e0d5d96a90f4c6caeb3a4c9c3c0c` (Lane A PR #69).
Browser contract: human-approved `envoi-browser-names v1`.
Name-only consuming pins: `a3-pause-auth v3`, `a4-wake v2`.

The canonical registry and fixtures load through the existing shared loader with no copies. Run these commands from the paired server/client checkout in PowerShell:

```powershell
npx vitest run --config vitest.contract-review.config.ts
npx vitest run --config vitest.a4-review.config.ts
npx vitest run --config vitest.browser-names-review.config.ts
```

For a separate publishing checkout, set `ENVOI_CONTRACT_FIXTURES_ROOT` to its exact `test/contract-fixtures` directory. The initial browser review passed 29 tests against `1b88e1d`; the current 29-test review pins the paired a3 v3/a4 v2 registry and consumes the #69 fixtures.

## Implemented behavior

- Browser mutations send only the default `x-envoi-csrf`, reading the configured cookie name from authConfig, with `envoi_csrf` as the fallback. The retired cookie is ignored by default.
- On a CSRF rejection, the existing identity recovery can restore a missing/changed token and retry once. An unchanged token cannot fix a wrong header/Origin, so that rejection is not replayed. A persistent `403 CSRF validation failed` emits a Reload-required event and shows an accessible Reload button across all app screens. Ordinary denials, successful recovery and late responses from invalidated sessions do not show it.
- Native EventSource hides HTTP status. An error triggers one current-session identity probe at a time. A 401 emits the existing session-expiry event, which clears private state, closes the stream and shows sign-in. Provider/network failures keep live updates recoverable; a late 401 from a previous workspace/session is ignored.
- The a3 review now requires v3, checks the three browser requests' new cookies/header/Origin and denies credential leaks from both generations. The a4 review requires v2, checks all 21 renamed bearer placeholders and the strengthened leak guard. Its normative prose remains under the original v1 heading with a v2 revision note.
- web is generated only through npm run build. Server, client, shared fixtures and pins integrate together on ONE SHA, and roll back together.

## Validation scope

The dedicated consuming tests validate all nine browser fixtures, cookie scope/clearing/lifetime, header order independence, Origin/header cases, callback redirects, nullable logoutUrl, second-factor decisions and real API response consumption. The 18 new focused recovery cases use the same canonical fixtures and check API retries, notice rendering/click behavior, expiry events, stream-probe coalescing and stale-session protection.

The full Lane B suite and contract reviews run on the exact paired tree; standard CI covers the normal lane suites, including the new recovery tests. Dedicated reviews are explicitly run locally and their counts are reported separately.

The paired validation PR must have exactly the N2-client Lane B tree and exactly PR #69's Lane A tree. It is validation evidence, not a standalone integration target. Client-only commits are supplied separately for coordinated integration.

Already loaded pre-cutover bundles cannot retroactively gain a new Reload control; a reload fetches the new no-store index.html. Hosted sign-in/WorkOS/dashboard acceptance and real-runtime gates remain human release work. No hosted evidence is claimed here.
