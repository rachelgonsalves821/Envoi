# Envoi landing page replacement

This is the original static review. See the [October 19 interactive revision](../marketing-2026-10-19/README.md) for the current implementation and screenshots.

The public landing page now opens the About page. Product is the second navigation item and is available at `/product`. `/about` is an alias for the About view. The signed-in workspace still uses the existing root route.

The implementation follows the supplied `envoi_revised_preview_v2.html` and `envoi_revised_coding_agent_prompt_v3.md`. It retains the story, founders, four-agent hero, distinct product screenshots, four benefits, six features, sign-in, and waitlist. Eyebrows and the duplicate inbox section are absent. The waitlist uses the existing API, including configured CSRF cookie handling.

## Screenshots

Captured from the production build at desktop 1440 × 1000 and mobile 390 × 844. Images show the full page.

| Page | Desktop | Mobile |
| --- | --- | --- |
| About | [Desktop screenshot](about-desktop.png) | [Mobile screenshot](about-mobile.png) |
| Product | [Desktop screenshot](product-desktop.png) | [Mobile screenshot](product-mobile.png) |

## Validation

- `npm run build` passes, including TypeScript and connector builds.
- `npm run test:frontend` passes all 203 tests.
- `node --test test/waitlist.test.js` passes both tests, including GET/HEAD on the public pages and the existing waitlist API.
- Browser checks confirm images load, no horizontal overflow, correct navigation order, unique Product screenshots, working section links, Escape dismissal and focus restoration, and waitlist failure/retry/success behavior.
- The browser checks mock identity and waitlist responses. They do not enroll an address in the production waitlist. The waitlist integration test uses isolated local storage.
- The production build was checked under the server's Content Security Policy, with no browser page errors.

For optional browser QA, supply an existing Playwright installation through `MARKETING_PLAYWRIGHT_MODULE` and a running local preview URL through `MARKETING_QA_URL`, then run `node scripts/marketing-qa.cjs`. The script defaults to Chrome, localhost port 5173, and `.chrome-qa/marketing` for output. `MARKETING_QA_BROWSER` and `MARKETING_QA_OUTPUT` override those defaults.

The screenshots are provided for review before merging. This change does not deploy the site.
