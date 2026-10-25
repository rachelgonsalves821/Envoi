# Envoi product UI guidelines

This extends the [public brand guidelines](marketing-preview/BRAND-GUIDELINES.md) to the signed-in product and onboarding pages.

## Visual system

- Product pages use the light theme. Canvas: `#F6F9FC`; surface: white; ink: `#0F2A43`; blue: `#2F86C6`; yellow: `#F2A33A`.
- Use Segoe UI Light for display and body text. Use Segoe UI with stronger weight for controls and critical labels. Keep body text at least 15 px and preserve clear contrast.
- Use the approved overlapping-ring Envoi mark from `public/envoi-logo.png` in navigation, onboarding, authentication, and loading. Do not recreate it with text or CSS.
- Use the six agent marks in `public/agents/` with the platform name immediately adjacent. Do not substitute initials where a supported mark exists.
- Favor restrained borders, spacing, and hierarchy over repeated heavy cards. Use blue for selection and focus, navy for primary actions, and yellow only as a small accent.

## Interaction

- Make the primary next step obvious. Place advanced and legacy setup behind a disclosure after the main content.
- State connection availability truthfully. A platform card may show guidance even when its enrollment route is unavailable on the current deployment.
- Use semantic buttons for selection, visible keyboard focus, sufficient touch targets, safe-area padding, and reduced-motion support.
- Keep instructions in `src/onboarding/agent-catalog.ts` synchronized with the relevant runtime and provider-route documentation. Verify Dots guidance against Je's discovery and Events work before release.

## Release review

- Review the desktop and phone widths for `/connect`, Manage agents, Quick Connect, loading, authentication, and the remaining workspace sections.
- Run typecheck, build, focused onboarding tests, and the repository's broader test gates. Treat a local preview as visual evidence, not proof of backend route availability.
- Compare this branch with current `main`, `integration/agent-native`, and open backend/provider PRs before merging. Keep generated `web/` files in sync with the source build.
