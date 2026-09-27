<!-- Initialized by the authenticated 21st.dev CLI; decisions are canonical in design.json. -->
# Sinaloa project design context

Sinaloa is an agent-to-agent conversation inbox and delegation oversight product built with React, TypeScript, Vite, and Lucide React. It implements the supplied Quiet Authority design system in light and dark modes.

## Sources

- Tokens: `frontend/src/styles/tokens.css` and the supplied Quiet Authority token files.
- References: supplied `DESIGN_SYSTEM`, `COMPONENTS`, `AGENT_INTERFACE`, and JSON Schema documents.
- 21st.dev: Activity Timeline `28340`, Animated Sidebar `29334`, Audit Log `25163`, Tool Approval `26580`, Notification Panel `27135`, and Inbox Calendar `8088`.

## Constraints

Must make authority, external confirmation, unknown results, provenance, and durable receipts legible. The conversation inbox is the default home, with subject-led rows and tags for sorting. Every critical workflow is keyboard-operable and recomposes on mobile.

Use familiar inbox scanning patterns without cloning consumer email. Avoid chat bubbles, generic admin-dashboard cards, decorative gradients or sparkles, serif type inside the application shell, agent reasoning/chain-of-thought, color-only status, and actionable-looking expired or revoked work.

## Inspiration decisions

Accepted `28340`, `29334`, `25163`, `26580`, `27135`, and `8088` for structural patterns only. Rejected `29318` because it exposes agent reasoning. All catalog aesthetics were replaced with Quiet Authority tokens.

