# Interactive Envoi marketing pages

The About hero is now a React/SVG handoff demo. Select any of four agents, follow the animated connection, pause or advance the steps, approve the handoff, and replay. Automatic progression stops at human approval. Reduced motion disables autoplay and moving beams.

The Product page has one clickable inbox demo in the How Envoi works section. The empty screenshot at the top and every Product waitlist CTA have been removed. About retains its waitlist flow.

The inbox supports opening cases, searching, status filters, approval and change requests, local notes, scoped file details, permission summaries, activity receipts, and resetting the sample workspace. These actions update only local demo state. On phones, opening a case shows its detail view with a back button. The four benefit cards retain numbers 1 to 4.

## Review images

| View | Desktop | Mobile |
| --- | --- | --- |
| About | [Full page](about-desktop.png) | [Full page](about-mobile.png) |
| Product | [Full page](product-desktop.png) | [Full page](product-mobile.png) |
| Approved handoff | [Hero](handoff-approved-desktop.png) | [Hero](handoff-approved-mobile.png) |
| Inbox receipt | [Inbox](inbox-approved-desktop.png) | [Inbox](inbox-approved-mobile.png) |

## Validation

- Production build and TypeScript pass.
- Frontend test suite passes.
- Chrome tests run against the production server and its Content Security Policy at 1440 and 390 px widths. Additional layout checks cover 820 and 320 px.
- Tested approval, request changes, notes, search and empty results, status counts, file scope, permissions, activity, keyboard case selection, reset, reduced motion, autoplay, pause, resume, approval gating, and replay.
- Demo interactions make zero API writes. About waitlist failure, retry, success, Escape, and focus restoration are checked with mocked responses.
- No horizontal overflow or browser page errors in the desktop/mobile runs. See [machine-readable results](results.json).
- No new runtime dependency. Replacing the raster illustrations lowers the generated HTML payload compared with the previous revision. Core Web Vitals and Lighthouse scores have not been measured; no field-performance claim is made.

Interaction inspiration came from [21st.dev Animated Beam](https://preview.21st.dev/%40dillionverma/components/animated-beam) and [AI Agent Pipeline](https://preview.21st.dev/%40monolythdev/components/ai-agent-pipeline). The demos are implemented in the existing React/CSS/SVG stack without copying those components or adding animation packages.

This supersedes the October 18 screenshot review. The draft PR remains for visual review; no merge or deployment has been performed.
