# Team banner on About

October 22, 2026 follow-up for PR #191.

- The team banner is the final section in About, immediately before the footer, not a separate navigation tab.
- About and Product remain the only main navigation links. The footer Team link points to `/#team`; legacy `/team/` requests redirect there.
- The About hero remains its only h1. The team section uses h2 and founder names use h3.
- Existing portraits, logos and Light/Dark/System controls are unchanged. Je's three review-only checklist items are unchanged.
- Automated tests cover placement, footer link, redirect and heading hierarchy. Built-page checks enforce section IDs, active navigation and internal links. The short About overview retains its original word budget independently of founder details.
- The refreshed local preview was visually checked at `/#team`; the screenshot below shows the banner and the two-tab navigation in System mode. Older standalone Team captures in `theme-team.md` are historical, not evidence of the new placement.

![Team banner at the bottom of About](about-team-banner.png)
