# envoi-browser-names v1 consumption review

Publication: `1b88e1d57edd17e1fe1ca0e0f69f54b73be4fac3` (Lane A draft PR #64).
Scope: fixture-only Lane B review; production N2-client is held for human approval.

The dedicated runner reads `test/contract-fixtures/index.json` and its registered files through the existing shared loader. No fixture copies are checked in. To review the publication from an integration-based checkout in PowerShell:

```powershell
$env:ENVOI_CONTRACT_FIXTURES_ROOT = 'C:\Users\KAILASH\.codex\worktrees\n2-browser-contract-review\Sinaloa\test\contract-fixtures'
npx vitest run --config vitest.browser-names-review.config.ts
Remove-Item Env:ENVOI_CONTRACT_FIXTURES_ROOT
```

The publication path can be replaced by another checkout at the exact published SHA. Before integration, standard frontend CI does not run this dedicated pre-approval review; its success is separate evidence.

29 tests cover all nine fixtures: declared schemas, independent cookie/header table, host-only scope, Path/HttpOnly/SameSite/Secure/Max-Age, header order independence, cookie replacement/clearing, nullable logoutUrl, local second-factor response, callback redirect, Origin and new-header positive logout versus isolated old-header rejection. Existing frontend API tests consume config, logout, phone verification, plain CSRF errors and me 401 directly from the fixtures.

## Findings for approved N2-client

- Change the header to x-envoi-csrf and the fallback to envoi_csrf; config-driven cookie reading already accepts envoi_csrf. Overrides still come from authConfig.
- The existing request helper attempts CSRF recovery through me and retries once. A persistent rejection remains an ApiError with status 403 and message/code CSRF validation failed. N2-client must offer Reload and ensure old-tab failures do not keep replaying the same mutation. This review does not implement the recovery UI.
- Native EventSource exposes no HTTP status. App.onerror already probes api.me(); the canonical me-old-cookies-only response emits SESSION_EXPIRED_EVENT through the existing API. N2-client must verify that the mounted app closes the stream, clears private state and shows sign-in. A real stream or mounted UI is not tested by this fixture review.
- A sign-in started before cutover redirects to /?auth_error=sign_in_failed and clears both flow generations. The browser can start sign-in again. API fetch helpers do not consume WorkOS redirects; browser navigation does.
- All retired cookies are cleared after sign-in/local verify/logout; me 401 clears only carried retired names. Fixtures show host-only clearing. Lane A must separately test Domain plus host-only session clears and startup rejection of retired overrides/equal session-CSRF names.
- Origin is required in addition to matching cookie/header. Browsers generate it on mutations; it is not a header the frontend should fabricate. Lane A must test missing/wrong Origin, safe methods and exemptions on the real server.
- The a3 v2 and a4 v1 registry entries and review pins remain unchanged at publication. At the single N2-server/N2-client integration SHA, Lane A publishes a3 v3/a4 v2 and Lane B updates both pins. No version bump is performed here.
- Build web through npm run build on the approved client change. Reload can retrieve new index.html because it is served no-store. An already loaded pre-cutover bundle cannot gain a new Reload control retroactively; integration/release handling must account for that limitation.
- Dashboard cookie-name override checks, pre-cutover WorkOS sign-out and hosted acceptance are human/Lane A release work. This review has no hosted evidence. Rollback reverts server, client, shared fixtures and review pins as one SHA; cleared old cookies require another sign-in.

All expected-versus-observed fixture checks match. The API/header/UI implementation gaps above are expected pre-approval client work, not fixture MISMATCH findings.
