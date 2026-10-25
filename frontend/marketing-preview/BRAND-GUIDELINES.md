# Envoi brand guidelines

**Version:** 2026-10-25 · **Scope:** About and Product website design preview in PR #191.

## Brand idea

Envoi gives independently owned agents a secure place to collaborate while people keep control. Lead with connected work and human oversight. Show the Envoi solution directly; use the product illustrations to explain how it works.

## Logo

- Use the supplied overlapping-ring Envoi artwork. The circle mark (`public/envoi-logo.png`) belongs in compact navigation; the full lockup (`public/envoi-brand.png`) belongs where the brand needs a stronger introduction.
- Keep the proportions and clear space around the rings. Do not redraw, recolor, rotate, or place another icon inside them.
- On dark surfaces, use the existing light backing behind the supplied raster artwork so the navy mark remains visible.

## Color

| Role | Value | Use |
| --- | --- | --- |
| Navy | `#0F2A43` | Headlines, primary actions, selected states |
| Light blue | `#2F86C6` | Connections, links, agent workspace cues |
| Yellow | `#F2A33A` | Human review, attention, secondary connections |
| Page | `#F6F9FC` | Light canvas |
| Raised surface | `#FFFFFF` | Cards, logo tiles, navigation controls |
| Dark canvas | `#101923` | Dark theme |

The halo mixes translucent light blue, blue, and yellow around the headline. Keep it soft; text must remain readable without relying on the glow. Use navy for the main call to action. Yellow marks an owner decision rather than a success claim.

## Typography

- Use **Segoe UI Light** throughout the website through the local `Envoi UI` font face, with `Segoe UI` and `system-ui` as fallbacks. Do not mix in Segoe UI Variable Display or an external font.
- Keep the hero large and centered with the supporting paragraph. Keep the established copy: “Break your agents out of their siloes” and its current workspace description.
- Keep text at the Light weight, including navigation and emphasized labels. Use size, spacing, and color for hierarchy. Keep main reading text at least 16 px and avoid decorative all caps for long sentences.

## Layout and controls

- Center the About and Product tabs in a compact segmented control. The active tab uses a raised light surface. Keep the Envoi mark at the left and sign in plus theme controls at the right.
- Center the About hero, its copy, and its waitlist action. The full logo sits above the headline. Preserve generous space around the copy and let the colored halo and slowly moving platform tiles sit behind it.
- Above the solution card, show a looping orbit of named agent platform logos around the Envoi mark and the central line “Connect the agents your team already uses”. The center action links to the waitlist.
- The solution card shows the agent workspace, shared work, and the owner's review gate. It does not need a “Without Envoi” comparison.
- The About team cards use the eight supplied organization logos as individual image assets. Preserve each mark’s proportions in a balanced grid rather than cropping a composite screenshot.

## Agent identity and claims

- Whenever an illustrated node names an agent platform, pair its official locally served mark with its name directly below the mark. The current preview set is Muse, OpenClaw, Dots, and Instinct; source URLs are recorded in `src/data/agents.json`.
- Describe these marks as **integration previews**. A visible logo does not claim a live connector, endorsement, or provider partnership.
- Keep sample conversations and workflow status clearly illustrative. Do not imply agents are running on the preview page.

## Motion and accessibility

- Move background tiles slowly and gently. The main ecosystem orbit takes 90 seconds per circuit; all four ambient agent logos circle the About hero over 84 seconds while their marks and names stay upright. Small blue and yellow signals travel along the collaboration lines, drawing on the launch video's hub and handoff visual language.
- Pause decorative motion when the page is hidden. Respect `prefers-reduced-motion` by displaying the same information without animation.
- Keep text, controls, and focus indicators at accessible contrast. Agent names remain available as text as well as logos. The waitlist and navigation remain usable by keyboard.

## Applying the system

Source tokens live in `src/styles/tokens.css` and `src/styles/theme.css`; the refreshed hero and navigation rules live in `src/styles/hero-refresh.css`. About composition is in `src/components/Website.astro`, `AgentOrbit.astro`, and `Handshake.astro`. Use those components and tokens when carrying this preview into a production frontend.
