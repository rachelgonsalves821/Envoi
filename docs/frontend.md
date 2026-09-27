# Human Interface frontend

Sinaloa’s browser UI is a React + TypeScript application under `frontend/`. Vite builds a self-contained production `web/index.html`, which the existing Node server serves at `/`. The inlined build can also be copied to a static host without breaking asset paths. No backend source changes are required for the frontend build.

## Commands

- `npm run dev:web` — starts Vite on port 5173 and proxies `/api` to the backend on port 8787.
- `npm run build` — type-checks through Vite and emits production files to `web/`.
- `npm run test:frontend` — runs the Human Interface translation tests.
- `npm test` — runs the existing backend/API tests.

## Runtime contract

The UI authenticates through `/api/auth/config` and preserves both supported human flows:

- Production: WorkOS-hosted sign-in/sign-up and cookie-backed sessions.
- Development: phone verification followed by TOTP, with the bearer session kept in browser local storage.

After authentication, it discovers organizations and workspaces, reads `/api/inboxes/:id/human-view`, and renders the machine-facing Case/Event/Proposal/PolicyEvaluation/Receipt objects. Human decisions are posted to `/api/inboxes/:id/cases/:caseId/actions` as `approveOnce`, `decline`, `editProposal`, `pause`, `revoke`, or `takeOver`. Agent enrollment uses the 15-minute, one-time token endpoint.

Agent-to-agent work is rendered as a typed exchange ledger rather than chat bubbles. The case header identifies the acting agent and counterparties, message/proposal events retain explicit From/To identities and direction, and proposal history attributes offers and counteroffers to a party. The UI reads `participantDirectory` from the human view (or a case-local directory when supplied), falls back to case participants and event sender/recipient IDs, and labels unresolved identities as `Unknown external agent` without inventing profile data.

WorkOS sessions use the SSE observation stream. Local bearer sessions use a 30-second read refresh because browser `EventSource` cannot attach the required authorization header.

## Design provenance

The project design context lives in `.21st/`. The authenticated 21st.dev account `rachelgonsalves821` initialized it on 2026-09-27.

Accepted inspiration:

- `28340` — Activity Timeline. Adapted the semantic ordered list, actor/action/time grouping, and continuous rail for Sinaloa’s typed decision trace.
- `29334` — Animated Sidebar. Adapted focus-managed mobile navigation, keyboard-safe dismissal, and reduced-motion behavior; the catalog component’s generic dashboard styling was not copied.
- `25163` — Audit Log. Used as a structural reference for the append-only activity table.
- `26580` — Tool Approval. Used as a conceptual reference for deliberate approve-once/deny authority moments.

Rejected inspiration:

- `29318` — Agent Activity. Rejected because it visualizes model reasoning and tool traces, which violates Sinaloa’s human-observation boundary.
- Generic dashboard sidebar results were rejected when they emphasized metrics/cards over cases, authority, and durable outcomes.

All visual values come from `frontend/src/styles/tokens.css`, which mirrors the supplied Quiet Authority light/dark token system. Icons come from Lucide React and use text labels for critical meaning.

## Known API gaps

- Global pause has no backend route. The control is visible but explicitly reports that it is unavailable.
- Policies are observable through case evaluations, but policy creation/editing has no human API.
- Connected agent health and integration-specific revocation are not exposed as dedicated resources; the page shows the available identity, onboarding, and permission data.
- Receipt PDF export and share endpoints do not exist. The UI provides a print-ready receipt.
- Proposal field editing accepts the `editProposal` action but the backend does not yet accept a structured edit payload from humans.
