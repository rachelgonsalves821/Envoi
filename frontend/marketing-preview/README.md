# Envoi website design

The current About page direction and reusable visual rules are documented in [Brand guidelines](./BRAND-GUIDELINES.md).

For UI implementation and review, use the shared [UI design references](../UI-GUIDANCE.md).

For production integration and main-branch gates, follow the [PR #191 readiness plan](./PR-191-MAIN-READINESS.md).

The design began as an isolated marketing preview based on Rachel's `SKILL (1).md`, with public-facing copy drawn from `Envoi_vNENPitch.pdf`. The combined release candidate now packages the preview into the root build and serves it from the backend; it remains undeployed.

## Theme and Team update on October 22, 2026

About and Product share compact sun/moon radio controls at the right of the header for Light/Dark only. Accessible names and hover tooltips identify the icon-only choices. The team banner appears at the bottom of About, linked from the footer at `/#team`; the old `/team/` route redirects there instead of remaining a separate tab. Until an explicit choice is saved, the initial theme follows the operating system; legacy saved System preferences remain compatible and the selected icon reflects the resolved Light or Dark theme. Explicit choices persist in local storage under `envoi-theme`, and other tabs synchronize the preference. An allowlisted inline head bootstrap applies the choice before paint. If storage is blocked, selection still works for the current page. Without JavaScript the site follows the system color scheme and hides the nonfunctional controls.

The team banner uses the supplied names, roles, portraits and background logos: Rachel Gonsalves, CEO, Co-founder; Je Sai Kailash Pulipati, CTO, Co-founder. The supplied composite artwork is preserved locally in `public/team/founder-reference.png`; SVG viewports display its portraits and logo regions without redrawing them or inventing prose bios, institutions, endorsements or profile links.

The isolated package gate passes **48/48 tests**, static build/route/link checks and a full audit with zero vulnerabilities at the October 25 PR source head. Earlier browser checks covered About, Product and the former Team page in Light/Dark at 320, 375, 768, 1280 and 1920 requested viewport widths, with no page/header horizontal overflow (30 combinations). Navigation/reload persistence, native-radio keyboard selection and live System selection were checked; simulated operating-system changes and blocked storage are covered by unit tests, not an OS-settings change on the user's computer. See the historical [theme/Team screenshots and evidence](review-evidence/theme-team.md) and the latest [About team-banner placement evidence](review-evidence/about-team.md).

No root dependency changes or security-PR #195 code are included. Je's existing review-only checklist below is unchanged; no new implementation, security, test or deployment task is assigned to him.

## Copy source

Slide 2 supplies About's collaboration problem and high-level infrastructure solution. The hero combines “Break your agents out of their silos” with “connect the agents your team already uses” and preserves her description of agent addresses and workspaces, replacing the finance/recruiting example. Slide 3 supplies Product's four feature headings, shared-deliverable example, permissions, audit trails and approval language. The illustrated owner is named John throughout. Slide 1 supplies the closing invitation to get agents collaborating. Headings remain single sentences rather than pairs of short fragments. Universal compatibility wording is narrowed pending runtime confirmation. No deck metrics, pricing, team claims, enterprise adoption statistics or release targets are published.

## Preview

Requires Node.js 22.23.4 or newer and npm 9.6.5 or newer, matching the patched Astro toolchain.

```sh
npm ci
npm run dev
```

Open `http://localhost:4328/`. Production-build preview: `npm run build` then `npm run preview`. Run focused checks with `npm test`.

## Editing

The header has two page tabs with native links that work without JavaScript. About (`/`) contains only the problem, high-level workspace diagram and solution, without repeating feature columns or the comparison chart. Product (`/product/`) opens with the compact owner inbox and selected outcome, then shows detailed features, shorter interactive agent conversations with permissions/receipts, and a final Envoi × Monad permission concept. Each feature is explained once, followed by concrete examples instead of repeated promises. Shared layout and footer live in `src/components/Website.astro` and `Footer.astro`; there is no duplicated page shell. Older links such as `/#your-view` redirect to the corresponding Product section.

The Monad card is an illustrative interaction: its five toggles change the example permissions and do not connect a wallet, create a signature, or submit a transaction. Enabling transactions reveals the additional limit and approval requirement. The Monad mark comes from the [official media kit](https://www.monad.xyz/media-kit). Monad documents its [Ethereum wallet and EVM compatibility](https://docs.monad.xyz/introduction/monad-for-developers); [EIP-712](https://eips.ethereum.org/EIPS/eip-712) defines structured-data signing. Envoi integration behavior and on-chain verification remain proposed, not implemented in this preview.

The footer uses the provided layout reference with Product, Agents, Company and Access columns. Legal pages, social accounts, contact details and launch badges are omitted until real approved destinations or evidence are available.

About's compact workflow illustration contrasts an owner-mediated relay with a shared agent workspace. Owner review is shown above agent activity rather than as an unexplained timeline tick. It is a static, accessible illustration of the client-review example, not a speed comparison or evidence of live execution.

- `src/data/scenarios.json`: illustrative conversations and receipts.
- `src/data/agents.json`: logo paths and their official asset sources for the integration previews, not a tested compatibility guarantee.
- `src/components/AgentOrbit.astro`: the About orbit adds Hermes and Anthropic marks to the four shared agent tiles. The Hermes icon comes from the [official Hermes Agent repository](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/public/apple-touch-icon.png); the Anthropic symbol comes from [Anthropic's press kit](https://www.anthropic.com/press-kit). Their appearance is a visual preview, not a partnership or tested connection claim.
- `src/components/AgentsBanner.astro`: continuous logo rail with hover/focus pause, explicit pause/play, offscreen pause and a static reduced-motion layout. Decorative repetitions are hidden from screen readers.
- `src/styles/tokens.css`: logo-derived navy, blue and amber palette, system typography and motion tokens.
- `public/envoi-brand.png` and `public/envoi-logo.png`: Rachel's original transparent logo artwork, with its lettering preserved.
- `src/components/Thread.astro`: shared scenario renderer.
- `src/scripts/site.ts`: tabs, playback, visibility, inbox illustration, forms and clipboard.
- `scripts/check-pages.mjs`: build-time verification of page separation, unique IDs, active tabs and internal links.

The Thread pauses on hover, focus, explicit pause, offscreen visibility and hidden documents. Manual scenario selection shows the complete conversation and stops automatic progression. Reduced motion is static. Content is server-rendered and readable without JavaScript.

## Signup and sign-in

The preview's visible calls to action link to the existing `/api/auth/workos/sign-up` route on `www.envoi-agents.com`, matching the configured beta public origin and WorkOS callback. The header and footer sign-in links use `/api/auth/workos/sign-in`. Confirm the public origin and callback configuration before launch; override `PUBLIC_SIGN_UP_URL` and `PUBLIC_SIGN_IN_URL` at build time if necessary.

The previous waitlist component and its acceptance test remain in the preview package but are no longer rendered on the About or Product pages. The static preview does not collect email addresses. No new backend, private credentials, or cross-origin workaround is included.


## Launch decisions

- Confirm tested public integration support and logo usage before launch. The four vendor marks identify integration previews and do not imply partnership or endorsement. No universal compatibility claim is used.
- No usage counters, investor metrics, customer proof, compliance badges or pricing claims are published.
- The sample agent email address and decorative closing address have been removed from the website. Agent enrollment behavior is unchanged.
- Policy, file editing, scheduling, negotiation and receipts are labeled illustrations, not proof of runtime execution. Approve precise security/privacy claims before publishing a trust or legal page.
- Add approved privacy/terms links before collecting account data publicly.
- Brand colors are sampled from the supplied artwork: navy `#0f2a43`, blue `#2f86c6`, amber `#f2a33a`. Text uses darker accessible variants where needed.
- Closing headline uses the deck's “Get your agents collaborating.”
- Preview is `noindex`. Remove this and add the confirmed canonical URL only for the approved public launch.
- The share image is generated as `public/og-image.png`; the hosted OG image URL will work only after integration on the approved public origin.

This package is submitted for source and visual review only. It does not replace the existing Vite frontend, change the root build, or serve any production route. Merging, deploying, or enabling collection on the existing domain requires separate approval.

## Je's review-only checklist

This is the current light-theme design candidate requested by Rachel, separate from the older draft PR #145. Neither draft is merged or closed by this work. Compare the designs before choosing which approach to integrate; do not merge both as independent public frontends.

From `frontend/marketing-preview` in PowerShell:

```powershell
npm ci
npm test
$env:ASTRO_TELEMETRY_DISABLED='1'
npm run build
npm run audit:security
npm run dev
```

The preview uses port 4328. If another local preview already uses it, run `npm run dev -- --port 4329` instead. Review `/` and `/product/`; the development server is not a deployment.

- [ ] Review the final About/Product design, copy, supplied logo and typography.
- [ ] Review the code and recorded interaction/responsive evidence for the demo, feature markers and inbox.
- [ ] Review the test/build/security results and scope boundaries, then approve the design candidate or leave review comments.

Je is not assigned implementation, dependency fixes, test execution, migration, provider configuration, CI wiring or deployment. The optional commands above are for reproducing evidence, not required tasks on his checklist. This PR asks for source/design review only, not production acceptance.

## Engineering follow-up after design review

These are separate coding-agent/release work items, not Je's checklist and not hidden completion claims for this preview:

| Owner | Follow-up | Status |
| --- | --- | --- |
| Frontend coding agent | Prepare the approved design integration while preserving analytics, security headers, existing routes, authenticated app and onboarding. The existing React/Vite app remains unchanged here. | Deferred until the design is reviewed. |
| Lane A CI/release coding agent | Wire the selected implementation into the owned CI/release path and validate its exact integration commit. Existing root CI does not run this nested package's test/build/audit automatically. | Separate root-config work; no root files changed here. |
| Backend/identity coding agent | Verify the approved public origin, same-origin waitlist route and WorkOS callback/sign-in wiring before enabling collection. | Not part of this isolated preview; collection stays disabled. |
| Product owner and release operator | Supply approved legal destinations, integration/logo-use confirmation and public security claims, then authorize any public rollout. | No publication, merge or deployment is authorized by this review. |

## Completed dependency remediation

Upgraded Astro from 5.18.2 to 7.4.2 and its Sharp dependency to 0.35.5; the vulnerable esbuild dependency is no longer installed. `npm run check` runs tests, the static build/link gate and an audit that fails on any reported severity. The full audit reports zero vulnerabilities, without suppressions, forced resolution overrides or changes to the product's root dependencies. Regression tests check the locked dependency versions. The former findings were [Astro AVIF optimization RCE](https://github.com/advisories/GHSA-26w7-cxv4-gfx2), [Sharp's affected image-processing libraries](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), and a low-severity esbuild Windows development-server issue. An audit does not replace application security review.

No changes to Gate B-local, provider resources, remote-auth flags, runtime code, server contracts, root configuration or generated `web/**` are included. Rollback before integration is simply to leave this draft unmerged; deleting the review package later has no live routing effect.

## Validation on October 21, 2026

- Final browser verification is complete against the patched Astro 7.4.2 preview. [Screenshots and interaction results](review-evidence/README.md) are included for review; no browser rerun is assigned to Je.
- Fresh isolated-worktree installation, all 31 focused tests, the static build/internal-link gate, and the full dependency audit pass after the reviewed toolchain upgrade. Public deployment still requires the remaining integration and acceptance checks above.
- Static Astro build and focused tests cover playback, title copy, hidden sample addresses, supplied logo assets, light typography and text contrast.
- Final About and Product checks at 320, 375, 768, 1280 and 1920 CSS pixels showed no horizontal overflow, including the diagram, conversation demo and inbox.
- Verified scenario switching, keyboard arrow navigation, complete manual scenario rendering, inbox filtering, detail selection and the non-collecting preview form.
- Reading text uses locally installed Segoe UI Light at weight 300, with Segoe UI and system fallbacks. CTA labels use a synthesized bold treatment of the same face. No external font files are loaded or redistributed. The original logo artwork preserves its own lettering.
- Reduced-motion playback is covered by unit tests and CSS fallback, but OS-level browser preference switching was not exercised.
- Lighthouse scores and a full automated accessibility audit have not been measured. Do not describe these targets as passed.
- Compatibility, security claims, live waitlist integration and approved legal links remain launch confirmations, not tested product acceptance.
