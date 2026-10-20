# Interactive Envoi marketing pages

The About hero is now a React/SVG handoff demo. Select any of four agents, follow the animated connection, pause or advance the steps, approve the handoff, and replay. Automatic progression stops at human approval. Reduced motion disables autoplay and moving beams.

The Product page has one clickable inbox demo in the How Envoi works section. The empty screenshot at the top and every Product waitlist CTA have been removed. About retains its waitlist flow.

The inbox now follows the public staging frontend's light theme, gray navigation, full-width message rows, and list-to-conversation navigation. It includes agent inboxes, folders, Manage agents, participant cards, a conversation toolbar, and a Details panel. Cases, search, status filters, approvals, change requests, instructions, scoped files, permissions, activity, pause/resume, unread state, completion/reopening, and reset use local sample state. The four benefit cards retain numbers 1 to 4.

The reference is the public HTML/CSS served by [staging](https://sinaloa-staging.rachelgonsalves821.workers.dev/), compared with the repository's App.tsx and envoi-app.css. The signed-in staging inbox required authentication, so no private staging records were copied. See [reference hash and style checks](staging-reference.json). Demo addresses use example.com. Conversation/Files/Activity tabs and the reset control are demo conveniences.

## Review images

| View | Desktop | Mobile |
| --- | --- | --- |
| About | [Full page](about-desktop.png) | [Full page](about-mobile.png) |
| Product | [Full page](product-desktop.png) | [Full page](product-mobile.png) |
| Approved handoff | [Hero](handoff-approved-desktop.png) | [Hero](handoff-approved-mobile.png) |
| Conversation | [Full page](inbox-conversation-desktop.png) | [Full page](inbox-conversation-mobile.png) |
| Inbox receipt | [Inbox](inbox-approved-desktop.png) | [Inbox](inbox-approved-mobile.png) |

## Validation

- Production build and TypeScript pass.
- All 203 frontend tests and all 7 waitlist/HTTP security tests pass.
- Chrome tests run against the production server and its Content Security Policy at 1440 and 390 px widths. Additional layout checks cover 820 and 320 px.
- Tested approval, request changes, instructions, search and empty results, agent/folder/status filters, Manage agents links, file scope, permissions, Details, activity, keyboard case selection, mark unread, pause/resume, completion/reopening, reset, reduced motion, autoplay, approval gating, and replay.
- Demo interactions make zero API writes. About waitlist failure, retry, success, Escape, and focus restoration are checked with mocked responses. Analytics network requests are also mocked.
- No horizontal overflow or browser page errors in the desktop/mobile runs. See [machine-readable results](results.json).
- The demos add no runtime dependency. Main’s PostHog dependency, initialization, and successful waitlist event are preserved after resolving the branch conflicts. The rebuilt HTML is 1,881.07 kB, or 1,020.27 kB gzip, including the existing app and analytics. Core Web Vitals and Lighthouse scores have not been measured; no field-performance claim is made.

Interaction inspiration came from [21st.dev Animated Beam](https://preview.21st.dev/%40dillionverma/components/animated-beam) and [AI Agent Pipeline](https://preview.21st.dev/%40monolythdev/components/ai-agent-pipeline). The demos are implemented in the existing React/CSS/SVG stack without copying those components or adding animation packages.

This supersedes the October 18 screenshot review. The draft PR remains for visual review; no merge or deployment has been performed.
