# Envoi website design

An isolated marketing design preview based on Rachel's `SKILL (1).md`, with public-facing copy drawn from `Envoi_vNENPitch.pdf`. No existing Envoi checkout, provider configuration, live agent, or Gate B-local resource is changed.

## Copy source

Slide 2 supplies About's collaboration problem and high-level infrastructure solution. The hero uses Rachel's requested headline, “Break your agents out of their siloes”, and her description of agent addresses and workspaces, replacing the finance/recruiting example. Slide 3 supplies Product's four feature headings, shared-deliverable example, permissions, audit trails and approval language. The illustrated owner is named John throughout. Slide 1 supplies the closing invitation to get agents collaborating. Headings remain single sentences rather than pairs of short fragments. Universal compatibility wording is narrowed pending runtime confirmation. No deck metrics, pricing, team claims, enterprise adoption statistics or release targets are published.

## Preview

Requires Node.js 22.23.4 or newer and npm 9.6.5 or newer, matching the patched Astro toolchain.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4328/`. Production-build preview: `npm run build` then `npm run preview`. Run focused checks with `npm test`.

## Editing

The header has two page tabs with native links that work without JavaScript. About (`/`) contains only the problem, high-level workspace diagram and solution, without repeating feature columns or the comparison chart. Product (`/product/`) contains detailed features, interactive agent conversations, the owner inbox and permissions/receipts. Each feature is explained once, followed by concrete examples instead of repeated promises. Shared layout and footer live in `src/components/Website.astro` and `Footer.astro`; there is no duplicated page shell. Older links such as `/#your-view` redirect to the corresponding Product section.

The footer uses the provided layout reference with Product, Agents, Company and Access columns. Legal pages, social accounts, contact details and launch badges are omitted until real approved destinations or evidence are available.

About's compact workflow illustration contrasts an owner-mediated relay with a shared agent workspace. Owner review is shown above agent activity rather than as an unexplained timeline tick. It is a static, accessible illustration of the client-review example, not a speed comparison or evidence of live execution.

- `src/data/scenarios.json`: illustrative conversations and receipts.
- `src/data/agents.json`: logo paths and their official asset sources for the integration previews, not a tested compatibility guarantee.
- `src/components/AgentsBanner.astro`: continuous logo rail with hover/focus pause, explicit pause/play, offscreen pause and a static reduced-motion layout. Decorative repetitions are hidden from screen readers.
- `src/styles/tokens.css`: logo-derived navy, blue and amber palette, system typography and motion tokens.
- `public/envoi-brand.png` and `public/envoi-logo.png`: Rachel's original transparent logo artwork, with its lettering preserved.
- `src/components/Thread.astro`: shared scenario renderer.
- `src/scripts/site.ts`: tabs, playback, visibility, inbox illustration, forms and clipboard.
- `scripts/check-pages.mjs`: build-time verification of page separation, unique IDs, active tabs and internal links.

The Thread pauses on hover, focus, explicit pause, offscreen visibility and hidden documents. Manual scenario selection shows the complete conversation and stops automatic progression. Reduced motion is static. Content is server-rendered and readable without JavaScript.

## Waitlist and sign-in

The existing Envoi source exposes `POST /api/waitlist`, accepts JSON `{ email, company }`, and acknowledges with `{ accepted: true }`. The client preserves that contract. It never treats a non-JSON response or missing acknowledgment as success.

Collection is **disabled by default**. Preview submissions do not send or retain email addresses. Before enabling `PUBLIC_WAITLIST_ENABLED=true`, integrate the static output with the existing same-origin Envoi API and test the real response. Do not enable it on a static host without that route. No new backend, private credentials, or cross-origin workaround is included.

The sign-in link uses the existing `/api/auth/workos/sign-in` route on `envoi-agents.com`. Confirm the public origin and callback configuration before launch; override `PUBLIC_SIGN_IN_URL` at build time if necessary.

## Launch decisions

- Confirm tested public integration support and logo usage before launch. The four vendor marks identify integration previews and do not imply partnership or endorsement. No universal compatibility claim is used.
- No usage counters, investor metrics, customer proof, compliance badges or pricing claims are published.
- The sample agent email address and decorative closing address have been removed from the website. Agent enrollment behavior is unchanged.
- Policy, file editing, scheduling, negotiation and receipts are labeled illustrations, not proof of runtime execution. Approve precise security/privacy claims before publishing a trust or legal page.
- Keep waitlist-only pricing. Add approved privacy/terms links before collecting emails publicly.
- Brand colors are sampled from the supplied artwork: navy `#0f2a43`, blue `#2f86c6`, amber `#f2a33a`. Text uses darker accessible variants where needed.
- Closing headline uses the deck's “Get your agents collaborating.”
- Preview is `noindex`. Remove this and add the confirmed canonical URL only for the approved public launch.
- The share image is generated as `public/og-image.png`; the hosted OG image URL will work only after integration on the approved public origin.

This package is submitted for source and visual review only. It does not replace the existing Vite frontend, change the root build, or serve any production route. Merging, deploying, or enabling collection on the existing domain requires separate approval.

## Je's review and integration checklist

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

- [x] **P0 dependency security fixed:** upgraded Astro from 5.18.2 to 7.4.2 and its Sharp dependency to 0.35.5; the vulnerable esbuild dependency is no longer installed. The new `npm run check` runs tests, the static build/link gate and an audit that fails on any reported severity. The full audit now reports zero vulnerabilities, without suppressions, forced resolution overrides or changes to the product's root dependencies. Regression tests check the locked dependency versions. The former findings were [Astro AVIF optimization RCE](https://github.com/advisories/GHSA-26w7-cxv4-gfx2), [Sharp's affected image-processing libraries](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), and a low-severity esbuild Windows development-server issue. This is not a claim that this static illustration exercises every affected feature, or that an audit replaces application security review.
- [ ] Review the restored full hero logo, requested headline and paragraph, logo colors and Segoe UI Light typography with Rachel.
- [ ] Review the larger collaboration diagram, 16px conversation/inbox body text, 14px supporting labels, ordered feature markers and client-deck-first demo.
- [ ] Exercise keyboard scenario switching, play/pause, all inbox filters and subject/detail selection at mobile and desktop widths.
- [ ] Choose whether to port the approved design into the existing React/Vite app or explicitly authorize a separate static-site build and hosting integration. No Astro dependency or command was added to the root app.
- [ ] Preserve the existing site's analytics, security headers, public routes, authenticated app and agent onboarding during any future port. These are not wired into this standalone preview.
- [ ] Confirm the real public origin, WorkOS sign-in/callback and same-origin waitlist contract before enabling collection. Preview collection remains disabled; no credentials belong in the client or this package.
- [ ] Confirm integration support/logo usage, precise security claims and real privacy/terms destinations before public launch. Illustrative conversations are not hosted agent acceptance evidence.
- [ ] Add the approved package/ported design to the owned CI and release path, then validate the exact integration commit. Existing root CI does not run this nested package's `npm test` or Astro build automatically.
- [ ] Recheck the final hero changes in a browser; the most recent browser session timed out after the final logo/headline edits. Earlier responsive and interaction evidence must not be represented as exact-final visual acceptance.

No changes to Gate B-local, provider resources, remote-auth flags, runtime code, server contracts, root configuration or generated `web/**` are included. Rollback before integration is simply to leave this draft unmerged; deleting the review package later has no live routing effect.

## Validation on October 21, 2026

- Fresh isolated-worktree installation, all 31 focused tests, the static build/internal-link gate, and the full dependency audit pass after the reviewed toolchain upgrade. Public deployment still requires the remaining integration and acceptance checks above.
- Static Astro build and focused tests cover playback, title copy, hidden sample addresses, supplied logo assets, light typography and text contrast.
- Browser checks at 375, 768, 1280 and 1920 CSS pixels showed no horizontal overflow.
- Verified scenario switching, keyboard arrow navigation, complete manual scenario rendering, inbox filtering, detail selection and the non-collecting preview form.
- All non-logo text uses locally installed Segoe UI Light at weight 300, with Segoe UI and system fallbacks. No external font files are loaded or redistributed. The original logo artwork preserves its own lettering.
- Reduced-motion playback is covered by unit tests and CSS fallback, but OS-level browser preference switching was not exercised.
- Lighthouse scores and a full automated accessibility audit have not been measured. Do not describe these targets as passed.
- Compatibility, security claims, live waitlist integration and approved legal links remain launch confirmations, not tested product acceptance.
