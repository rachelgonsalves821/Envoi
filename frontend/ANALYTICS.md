# Beta product analytics

The React app and About/Product pages use `src/analytics.ts` and the same public
US PostHog project. Page views retain only a fixed public route, without query
strings, fragments or dynamic IDs. The filter preserves the project token and
anonymous browser/device/session/window IDs needed for ingestion and journeys.
It excludes account IDs, email addresses, message content, form values, referrers
and person properties. Autocapture, replay, surveys and feature flags are disabled.

Events: `$pageview`, `sign_up_started`, `sign_in_started`, `beta_app_opened`,
`waitlist_joined`, `workspace_created`, `agent_enrollment_started`, `agent_approved`,
`case_decision_submitted`, `instruction_sent`, `invitation_accepted`.
Auth events mean clicks, not completed registration or sign-in. Product actions
mean a successful response to an owner browser request; server/agent activity is
not instrumented. A browser ID is not a verified user identity, and blockers or
disabled browser storage can reduce coverage. No person profile is created.

Optional build-time overrides are `VITE_POSTHOG_PROJECT_TOKEN` / `VITE_POSTHOG_HOST`
for the app and `PUBLIC_POSTHOG_PROJECT_TOKEN` / `PUBLIC_POSTHOG_HOST` for marketing.
Keep both builds on the same project/host for joined journeys. Tokens are public
browser project tokens, not personal API keys. Blank development builds stay off.

Run `npm run test:frontend`, `npm --prefix frontend/marketing-preview test`, and
`npm run build`. Generated `web/**` files must come from that build.

After an authorized release, open About, Product, and the app in one browser.
Verify `$pageview` and an auth click in the correct PostHog project's live events,
with a consistent anonymous ID and session ID and sanitized `$current_url`.
Check successful owner actions during an approved beta test. A local/CI pass
does not prove receipt by PostHog or deployment; confirm this live receipt before
calling analytics launch-ready. There is no replay or heatmap promise.
