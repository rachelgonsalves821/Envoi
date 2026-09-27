<!-- Initialized by the authenticated 21st.dev CLI; decisions are canonical in design.json. -->
# Sinaloa project design context

Sinaloa is a case-first delegation oversight product built with React, TypeScript, Vite, and Lucide React. It implements the supplied Quiet Authority design system in light and dark modes.

## Sources

- Tokens: `frontend/src/styles/tokens.css` and the supplied Quiet Authority token files.
- References: supplied `DESIGN_SYSTEM`, `COMPONENTS`, `AGENT_INTERFACE`, and JSON Schema documents.
- 21st.dev: Activity Timeline `28340`, Animated Sidebar `29334`, Audit Log `25163`, Tool Approval `26580`.

## Constraints

Must make authority, external confirmation, unknown results, provenance, and durable receipts legible. Needs me is the default home. Every critical workflow is keyboard-operable and recomposes on mobile.

Avoid email and chatbot metaphors, generic admin-dashboard cards, agent reasoning/chain-of-thought, color-only status, and actionable-looking expired or revoked work.

## Inspiration decisions

Accepted `28340`, `29334`, `25163`, and `26580` for structural patterns only. Rejected `29318` because it exposes agent reasoning. All catalog aesthetics were replaced with Quiet Authority tokens.

