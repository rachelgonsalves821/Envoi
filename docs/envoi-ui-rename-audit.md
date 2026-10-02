# Envoi UI rename audit

This audit covers local branch `rename-envoi-ui` through `4b1a9a3`. It has not been pushed, merged, or deployed. The parallel domain branch `migrate-envoi-domain` owns live URLs, DNS, WorkOS, and server domain configuration. The intended address cutover retires old agent addresses rather than retaining aliases; existing stored addresses need an explicit migration and live delivery check before that decision is applied.

## Changed files

| File | Change |
| --- | --- |
| `docs/quick-connect.md` | Uses Envoi language and the new download/setup filenames in onboarding instructions. |
| `frontend/index.html` | Updates title, description, and social-card words while retaining URLs. |
| `frontend/src/App.tsx` | Renames visible UI copy, preview agent address, setup commands, download names, and displayed legacy error text. |
| `frontend/src/LandingPage.tsx` | Renames visible landing-page brand copy. |
| `frontend/src/model.ts` | Displays legacy branded status codes as Envoi. |
| `frontend/src/quick-connect.ts` | Generates Envoi connector downloads and setup prompt filenames. |
| `frontend/test/human-access.test.ts` | Updates onboarding UI expectations. |
| `frontend/test/landing.test.ts` | Updates landing-page text expectations. |
| `frontend/test/quick-connect.test.ts` | Updates setup/download prompt expectations. |
| `integrations/agent-bridges/bridge.ts` | Renames operator-facing bridge text. |
| `integrations/agent-bridges/interoperability.test.ts` | Updates expected bridge text. |
| `integrations/agent-bridges/mcp-relay.ts` | Renames relay errors shown to operators or agents. |
| `integrations/agent-bridges/providers.ts` | Renames provider-facing diagnostics. |
| `integrations/agent-bridges/share-asset.ts` | Renames asset-sharing diagnostics. |
| `integrations/connector/cli.ts` | Renames CLI help and setup errors. |
| `integrations/connector/core.test.ts` | Covers renamed reachability status. |
| `integrations/connector/core.ts` | Renames setup progress, errors, and reachability status. |
| `integrations/connector/service.ts` | Renames service diagnostics. |
| `integrations/connector/store.ts` | Renames saved-state diagnostics. |
| `integrations/connector/vite.config.ts` | Emits `envoi-connector.mjs`. |
| `integrations/grok/README.md` | Renames product prose while preserving current protocol/configuration identifiers. |
| `integrations/grok/adapter.ts` | Renames local adapter diagnostics. |
| `integrations/grok/mcp-smoke.ts` | Renames MCP smoke-test output. |
| `integrations/grok/run.ts` | Accepts Envoi-named local bridge variables with legacy fallbacks and renames errors. |
| `integrations/grok/runtime.ts` | Accepts `ENVOI_MCP_URL` with legacy fallback. |
| `integrations/hermes/README.md` | Renames product prose, connector/setup commands, and Windows flag while retaining live URLs and MCP identifiers. |
| `integrations/hermes/adapter.ts` | Renames Hermes adapter diagnostics. |
| `integrations/hermes/api.ts` | Renames Hermes API diagnostics. |
| `integrations/hermes/config.ts` | Renames Hermes configuration diagnostics. |
| `integrations/hermes/connect-windows.ps1` | Displays Envoi text and accepts `-EnvoiUrl`; retains the prior flag and state path for compatibility. |
| `integrations/hermes/run.ts` | Accepts Envoi-named local bridge variables and prints Envoi connection status. |
| `integrations/hermes/runtime.ts` | Renames Hermes runtime diagnostics. |
| `integrations/hermes/turn.ts` | Renames Hermes turn diagnostics. |
| `integrations/openclaw/README.md` | Renames product prose while retaining current protocol/configuration identifiers. |
| `integrations/openclaw/mcp-smoke.test.ts` | Updates smoke-test output expectations. |
| `integrations/openclaw/mcp-smoke.ts` | Renames smoke-test output. |
| `integrations/openclaw/quick-connect-cli.ts` | Renames OpenClaw setup help. |
| `integrations/openclaw/quick-connect-config.ts` | Renames OpenClaw configuration diagnostics. |
| `integrations/openclaw/quick-connect.ts` | Renames OpenClaw setup output. |
| `integrations/openclaw/quick-connect.vite.config.ts` | Emits `envoi-openclaw.mjs`. |
| `integrations/openclaw/run.ts` | Accepts Envoi-named local bridge variables with legacy fallbacks. |
| `integrations/openclaw/turn.ts` | Renames OpenClaw turn diagnostics. |
| `scripts/package-openclaw.mjs` | Packages new artifact names and metadata while retaining old download aliases for existing installations. |
| `sdk/typescript/src/connector.ts` | Renames connector error messages. |
| `sdk/typescript/src/index.ts` | Renames error messages while preserving the public `SinaloaError` class/name. |
| `sdk/typescript/src/quick-connect.ts` | Renames setup prompt and error text. |
| `sdk/typescript/test/client.test.ts` | Updates client error text expectation. |
| `test/quick-connect-download.test.js` | Executes and hashes new standalone connector downloads. |
| `web/downloads/envoi-connector.mjs` | New generated unified connector. |
| `web/downloads/envoi-openclaw.mjs` | New generated OpenClaw connector. |
| `web/downloads/release.json` | Lists SHA256 hashes for new artifact filenames. |
| `web/downloads/sinaloa-connector.mjs` | Refreshed compatibility download for previously published URL. |
| `web/downloads/sinaloa-openclaw.mjs` | Refreshed compatibility download for previously published URL. |
| `web/index.html` | Rebuilt bundled front end from renamed source. |

## Remaining old-name references

- **URLs and stored agent addresses:** live `beta.sinaloa-inbox.com` and `agents.sinaloa-inbox.com` references, plus existing database rows, require the parallel domain deployment and an explicit address migration. Showing a new label for an old stored address would make copied addresses undeliverable. Old addresses are to be retired at cutover, not silently aliased.
- **Cloudflare configuration:** the Worker, scanner, and deployment preflight still read `SINALOA_*` variables and secrets. Do not rename dashboard keys until a coordinated code/config migration is deployed and validated. The new `ENVOI_*` aliases in this branch apply to local agent bridges, not to Cloudflare Worker secrets.
- **Protocol and public API identifiers:** MCP tools/servers named `sinaloa_*`, the `SinaloaError` SDK class, error codes, headers, cookie/storage keys, DB names, and code identifiers remain for compatibility. These are not product copy. Changing them needs a versioned protocol/data migration and client acceptance tests.
- **Compatibility downloads:** the old `sinaloa-*.mjs` paths remain available for already published setup links. New UI and release metadata use `envoi-*.mjs`.
- **Historical project documents:** earlier launch plans and provider inventories retain the names under which services were created. They are historical records, not current UI copy.

No image, logo, SVG, or CSS file was changed. No image asset containing the old name was found. Local preview showed the Envoi name and agent-address example without a layout issue. The branch did not verify the live beta or migrate an enrolled agent.

## Verification

- `npm run build`: passed, including TypeScript checks and both connector artifacts.
- Frontend: 103 passed. TypeScript SDK: 38 passed. Integrations: 153 passed, 1 skipped (rerun outside the sandbox because Windows rejected temporary-file ACL operations inside it).
- Main test suite from the preceding packaging pass: 214 passed, 10 skipped. Generated download standalone tests: 2 passed.
- `git diff --check`: passed.
- Dry merge with `migrate-envoi-domain`: conflicts in `frontend/index.html`, `integrations/hermes/README.md`, and generated `web/index.html`. Resolve after both owners complete their branches, then rebuild and run exact combined-commit CI.
