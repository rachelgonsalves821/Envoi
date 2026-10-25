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
- Keep the hero large and centered with the supporting paragraph. The headline is “Break your agents out of their siloes and connect the agents your team already uses.” Preserve the current workspace description.
- Keep reading text at the Light weight, including navigation and emphasized labels. Calls to action use a bold treatment of the same type family with a font size one step larger. Use size, spacing, and color for hierarchy. Keep main reading text at least 16 px and avoid decorative all caps for long sentences.

## Layout and controls

- Center the About and Product tabs in a compact segmented control. The active tab uses a raised light surface. Keep the Envoi mark at the left and sign in plus theme controls at the right.
- Use thin outlined pill buttons with a light or raised surface, navy text, and rounded ends. Add a small arrow or action icon where useful. Apply the larger bold label to signup, sign-in, copy-link, and product demo controls across light and dark themes.
- Center the About hero and its “Start now” signup action. The full logo sits above the headline. Place the colored halo and a centered dotted orbit behind the copy; all four agent logos and names remain visible as they move slowly around it. Use one orbit in the hero.
- Pair the About explanation on the left with a smaller collaboration card on the right. On narrow screens, stack the text above the card.
- The collaboration card shows a sample Q4 data request and response moving between two named agents, scoped shared data, and the owner's review gate. Label it as illustrative. It does not need a “Without Envoi” comparison.
- Open Product with the owner inbox and outcome card directly below a compact introduction. On desktop, keep the heading, bold subject-line instruction, all three rows, and selected outcome within one viewport. Place feature explanations and the agent conversation after this first card.
- Keep sample conversations concise: one principal request and response, the applicable permission, and an outcome. Show the full thread without a nested scroll area at desktop widths.
- Finish Product with a split permissions card inspired by the soft, layered reference layout. Align the heading with the top of the visual and use navy, light blue and amber rather than borrowing its green palette. Keep five interactive permission switches; enabling transactions reveals the additional limit and approval requirement. Place the official Monad mark and the supplied value statement at the bottom of the visual. The card is labeled as an illustrative draft and does not show a signing workflow.
- The About team cards use the eight supplied organization logos as individual image assets. Preserve each mark’s proportions in a balanced grid rather than cropping a composite screenshot.

## Agent identity and claims

- Whenever an illustrated node names an agent platform, pair its official locally served mark with its name directly below the mark. The current preview set is Muse, OpenClaw, Dots, and Instinct; source URLs are recorded in `src/data/agents.json`.
- Describe these marks as **integration previews**. A visible logo does not claim a live connector, endorsement, or provider partnership.
- Keep sample conversations and workflow status clearly illustrative. Do not imply agents are running on the preview page.

## Motion and accessibility

- Move background tiles slowly and gently. All four agent logos circle the About hero over 84 seconds while their marks and names stay upright. The illustrative data request and response slide in opposite directions within the collaboration card.
- Pause decorative motion when the page is hidden. Respect `prefers-reduced-motion` by displaying the same information without animation.
- Keep text, controls, and focus indicators at accessible contrast. Agent names remain available as text as well as logos. Signup and navigation remain usable by keyboard.

## Applying the system

Source tokens live in `src/styles/tokens.css` and `src/styles/theme.css`; the refreshed hero and navigation rules live in `src/styles/hero-refresh.css`. About composition is in `src/components/Website.astro`, `AgentOrbit.astro`, and `Handshake.astro`. Use those components and tokens when carrying this preview into a production frontend.
