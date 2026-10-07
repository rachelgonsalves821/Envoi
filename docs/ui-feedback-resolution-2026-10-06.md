# UI feedback resolution — 2026-10-06

Source: Rachel's `UI Feedback.docx`. The seven embedded screenshots and written feedback were reviewed. Four coding agents worked on isolated file scopes; the lead integrated and cross-reviewed their changes.

## Confirmed decisions

- Done moves a conversation out of the main inbox into Done. It does not complete, pause or grant authority to the agent's underlying task.
- Folders, Done and read/unread annotations are personal to each signed-in human, like Gmail. Other authorized humans retain independent views.

## Implemented locally

| Feedback | Resolution |
| --- | --- |
| Removal history options | Labeled dropdown for retaining a read-only archive or deleting owned history/files; existing backend removal behavior retained. |
| Confirmation input loses typing | Modal focuses only on mount and keeps current close handlers in a ref; full agent names remain typeable across rerenders. |
| Gmail-like inbox | No initial selection. Full-width sender, subject and snippet rows; detail opens only after selection. Back returns to the list on desktop and mobile. |
| Back / Done / Move / Pause | Back works; Done and Move use durable personal annotations; Pause retains the existing authenticated case-control route and confirmation. Removed, terminal and unauthorized cases remain protected. |
| Human instruction composer | Dedicated manager-only own-case instruction route, idempotent durable messages, fenced claims and own-case agent replies. Instruction text does not approve an external action. |
| Header alignment | Left-aligned heading with agent context on a separate truncated line. |
| Folders and read/unread | Durable private folders and assignment; click acknowledges the displayed case revision. New events remain unread after a stale acknowledgment. Read and unread rows have distinct weights/backgrounds. |

Cross-review also fixed loss of Done navigation when switching inboxes, stale batched child refreshes after mutations, and annotations on older loaded history pages. Successful mutation responses are applied immediately; no optimistic or preview-only state is mistaken for durable storage. Instruction delivery-progress events collapse into one conversation bubble while preserving canonical audit events and separate replies. Other humans' instructions are not labeled “You.”

## Checks

- Production build and all TypeScript checks pass; generated website and connector downloads rebuilt.
- Backend: 278 tests pass, 10 skipped. Frontend: 193 tests pass. SDK: 75 tests pass. Runtime integration: 176 tests pass, 1 skipped. Cloudflare Worker: 6 tests pass.
- Real HTTP tests cover personal scope, restart persistence, stale read markers, actual case-state preservation, instruction admission/claims/replies, fences, retries, and permission/revocation/session guards.
- Browser design-preview checks cover list-first behavior, Back, removal/dropdown typing, folder dialogs and pause confirmation. Inbox and detail layout checks at 320, 390, 768, 1024 and 1440 px show no document-width overflow. Hosted browser mutations were not tested.
- Windows credential ACL tests require execution outside the filesystem sandbox; their permission enforcement was not weakened or bypassed.

## Release handoff

These changes are local and uncommitted. They have not been pushed, merged or deployed. The design preview uses explicit fixtures; mutation controls report that saving/sending is unavailable in preview rather than pretending to persist changes.

After an authorized PR/merge and exact-SHA beta deployment, refresh the installed connector bundle and restart each Hermes/OpenClaw/Grok bridge, retaining its private credentials. Updated connectors advertise `acceptHumanInstructions: true` on work claims. Existing connectors remain native-only, so they do not consume or fail human instructions they cannot understand. Queued instructions wait for an updated connector.

Before declaring hosted acceptance, sign in on beta and verify: create a folder, move a conversation, refresh and reopen it, mark Done and move back, verify independent views with a second human, send an instruction and observe the actual agent reply, then pause/revoke and verify further work is denied. External execution integrations remain separately permission-gated; this work does not enable payments, form submission or calendar execution.
