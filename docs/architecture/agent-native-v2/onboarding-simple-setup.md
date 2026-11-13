# Simple agent setup: plan and lane split

**Owner and approver:** pjsk02 · **Decided:** 2026-11-12 · **Base:** `onboarding/simple-setup`, cut from `main` @ `04ed191`

## 1. Goal

A first-time user knows what to do within five seconds. Every agent uses the same three steps:

1. **Pick the agent**: OpenClaw, Hermes, Grok or Dots.
2. **Name, address and permissions**: always visible, with Receive and Send pre-ticked.
3. **Copy one prompt and watch a small status row.**

Anything else (skill file, terminal setup, manual setup, extra prompts) sits behind a single "Stuck?" link. The agent does the setup work and tells the user when they're needed.

## 2. Decisions (owner, 2026-11-12)

| Topic | Decision |
|---|---|
| Handoff | One **Copy setup prompt** button. The skill file and terminal path move behind "Stuck?" |
| Preparation section | Removed. The connector checks everything before it uses the code (`integrations/connector/core.ts`, tested in `core.test.ts`) |
| Code lifetime | 30 minutes for now (was 15). Phase 3 check-ins replace this later |
| Permissions | Receive (required) and Send pre-ticked. Share files and Execute tasks are off, and the user can turn them on |
| Progress | The compact status row from the review mockup, inside step 3. No big panel |
| Dots | The same three steps. One prompt; the Dot walks the user through the plugin and approval |
| Owner's choice wins (Dots) | Approved **only if** the live ChatGPT test in §7 passes. 2026-11-12: the test can't run as first written (the staging plugin grants Receive only), so the owner chose to build it behind a flag and test it on staging first (§7) |
| Docs | Public `envoi-agents.com/docs`: OpenClaw, Hermes, Dots, Problems and fixes. No secrets, no internals |
| Prompt texts | **Unchanged in Phase 1.** Prompt edits need real-runtime testing |

## 3. Branches and merging

- `integration/agent-native` is behind `main` and lacks the current setup screens, so this work uses its own base, **`onboarding/simple-setup`**, cut from `main`.
- Task branches: `lane-a/onb-<slug>` and `lane-b/onb-<slug>`, each from the latest `origin/onboarding/simple-setup`.
- **Draft PRs go into `onboarding/simple-setup`**, never into `main`.
- Lane A merges green task PRs into the base and runs full CI on the result. Only the owner merges the base into `main` and deploys.
- Both Phase 1 PRs reach `main` together through the base, so the 30-minute code and the screen's longer watch time ship at once.

## 4. Phase 1: who does what

### File ownership (no overlap)

| Lane A (Claude) | Lane B (Codex) |
|---|---|
| `src/server.js` | `frontend/src/App.tsx` |
| `test/auth-enrollment.test.js` | `frontend/src/quick-connect.ts` |
| `docs/deployment.md` | `frontend/src/agent-permissions.ts` |
| `docs/agent-connectivity-beta.md` | `frontend/src/onboarding/DotsSetupGuide.tsx` |
| this file | `frontend/src/**/*.css`, `frontend/test/**` |
| | `integrations/hermes/README.md` |
| | `web/**`, rebuilt only with `npm run build` |

If either lane needs a file in the other column, post `REQUEST lane-a` or `REQUEST lane-b` on the build board with the exact change. Never edit it directly.

### Lane A (Claude): `lane-a/onb-p1-code-lifetime`

- [x] One constant, `enrollmentTokenTtlMs = 30 * 60_000`, used for enrollment, reconnect and re-enrollment codes (`src/server.js`).
- [x] Test: new and reconnect codes last 30 minutes, and the handoff carries the same expiry (`test/auth-enrollment.test.js`).
- [x] Update the "15-minute" text in `docs/deployment.md` and `docs/agent-connectivity-beta.md`.
- [x] Integrate both Phase 1 PRs into the base: #358 and #359, base head `b246057`. Lane B's changes stay within its files, with no overlap.
- [x] Full CI on the combined base head through PR #362: green ([run 43238539774](https://github.com/rachelgonsalves821/Envoi/actions/runs/43238539774)). Phase 1 is ready for the owner's screen check and merge into `main`.
- [ ] Prepare the Phase 2 contract draft once the §7 test results are in.

### Lane B (Codex): `lane-b/onb-p1-simple-screens`

**Step 1: pick the agent** (`App.tsx`, `RuntimePicker` and the enroll form)
- Remove the "Prepare your runtime before creating a token" expander.
- Add one line under the cards for the selected platform: "You'll need {Platform} running and an agent that can use a terminal on that computer." For Dots: "You'll need ChatGPT. Your Dot walks you through the Envoi plugin."

**Step 2: name, address and permissions**
- Show `AgentPermissionPicker` open, not inside a collapsed section. Remove the four greyed "Unavailable until supported" rows. Defaults stay `DEFAULT_AGENT_PERMISSIONS` (Receive and Send).
- For Dots, show the same rows read-only, with one line: "You'll confirm these on Envoi's approval page." Phase 2 makes them editable.

**Step 3: OpenClaw, Hermes and Grok**
- One sentence: "Paste this into your {Platform} agent, on the computer where {Platform} runs."
- One primary button, **Copy setup prompt**. It copies `setupPrompt(handoff)` unchanged.
- Keep the one-use warning, shortened to: "This prompt works once, until {time}. Share it only with your agent."
- Remove from view: "Download agent skill file", the "prefer the private setup file" sentence, the Hermes credentials notice, "View setup prompt", "Terminal fallback" and "Advanced setup · manual bridges".
- Add **one** collapsible entry, "Stuck? Other ways to connect". It holds, in this order: view the prompt, download as a skill file, terminal setup (the former Terminal fallback plus the preparation command), and manual setup (raw code and bridge variables).
- If the clipboard is unavailable, point the message to "Stuck? Other ways to connect" (it currently names "View setup prompt").
- Add the **status row** (the compact mockup): dots plus one changing line, in a `role="status"` region. Phase 1 dots are **Connected** and **Checked**.

| Enrollment phase | Line | Second line | Action |
|---|---|---|---|
| `waiting` | Waiting for your agent to start | Paste the prompt into your agent. The code works until {time}. | none |
| `enrolled` | Your agent is connected and finishing setup | This can take a few minutes. | none |
| `ready` | {Name} is ready | Setup checks passed. Send it a message to try it. | none |
| `expired` | This code expired before your agent used it | Nothing was set up yet. | Create new prompt |
| `revoked` | This connection was revoked | Review agent connections before trying again. | Create new prompt |
| `error` | Setup needs attention | Ask your agent what failed. It has the details. (Show `errorCode` small if present.) | Check again |
| status unavailable | Can't check progress right now | Your agent can keep going. | Check again |

- `watchEnrollmentStatus`: replace the fixed 20-minute limit with `expiresAt` plus 5 minutes. Otherwise a 30-minute code outlives the watcher.

**Step 3: Dots**
- One sentence: "Paste this into your Dot's chat. It will guide you through the Envoi plugin and approval."
- One primary button, **Copy setup prompt** (`dotsSetupPrompt`, unchanged). Then: "After you approve on Envoi's page, {Name} appears in your agents."
- Remove from view: "Open ChatGPT Plugins", the seven-step list, the receive-only notice, the three prompt buttons, both "View … prompt" sections, and "Download agent skill file".
- One "Stuck?" entry holds: check connection (verification prompt), add send access (message access prompt), background receiving (monitoring prompt), collect a report (diagnostic prompt), and the server URL.
- **Reconnect mode** (`reconnect=true`, used by the Permissions page and `DotsPermissionRecovery`): the one primary button is **Copy message access prompt**. Everything else goes behind "Stuck?".
- No status row for Dots in Phase 1. Phase 2 adds it once Envoi knows exactly which Dot it is watching.

**Also**
- In `integrations/hermes/README.md`, change "15-minute" to "30-minute".
- Keep the reconnect and re-enroll paths (`reconnectAgent`, `reenroll`) and the "Dots route unavailable" notice working.
- Rebuild `web/` with `npm run build` (Node 24 on PATH) and commit the result. This also clears a red CI step that is already failing on `main` @ `04ed191`: "Generated files match their sources" fails because `web/index.html` is stale there.

**Tests** (`frontend/test/**`)
- Rewrite the wording checks in `dots-guide-actions`, `dots-message-access`, `dots-onboarding` and `quick-connect` to check behaviour:
  - exactly one primary button per step
  - the copy button copies the unchanged prompt
  - "Stuck?" contains the alternatives
  - status lines and actions for each phase
  - Dots reconnect mode makes the message access prompt primary
  - the watcher lasts until `expiresAt` plus 5 minutes
- Keep `owner-reconnect-after-revoke` and `onboarding-connect` passing.

### Phase 1 checks
1. Each PR: green CI on its head. Lane B also runs `npm run test:frontend` and `npm run build` locally.
2. Base: Lane A integrates both PRs and runs full CI on the `onboarding/simple-setup` head. It must be fully green, including the PostgreSQL, Cloudflare and container steps. Those are skipped on a PR that fails the generated-files step: Lane A's PR #358 fails only there (inherited from `main`), while every test step passes.
3. Owner: a quick look at the setup screens for one OpenClaw or Hermes connection and the Dots screen. Then the owner merges the base into `main`.

**Done when:** every setup screen has one primary button and one "Stuck?" link, permissions are visible, the status row follows the table above, reconnect still works, and CI is green.

## 5a. Phase 2a: public setup docs (now, no contract needed)

**Goal:** when something fails, the user or their agent opens one page and finds the fix. Every setup error has a section, and the build fails if a new error has none.

**Pages** (style of maritime.sh/docs: left sidebar, simple search, one-column content):

| Address | Content |
|---|---|
| `/docs/` | What Envoi setup does in three steps; a "Which one do I need?" table (OpenClaw, Hermes, Grok, Dots); a **Copy instructions for your agent** button |
| `/docs/openclaw/`, `/docs/hermes/`, `/docs/dots/` | One guide each: what you need, the three steps, what the status row means, and common fixes linking to `/docs/fix/` |
| `/docs/fix/` | Problems and fixes: one `<section id="CODE">` per error code, each with **what happened** and **what to do** |
| `/llms.txt` | Plain-text index of the pages above, for agents |

**Rules for content.** Public and reviewed like code. Only user steps and fixes: no architecture, no internal design, no prompt internals, no secrets, never a setup code. It may name the public connector download and the `/mcp` address. Safety rules stay inside the prompts.

### File ownership (no overlap)

| Lane A (Claude): `lane-a/onb-p2a-docs-routes` | Lane B (Codex): `lane-b/onb-p2a-docs-pages` |
|---|---|
| `src/marketing-routes.js`: `/docs` → `/docs/`, `/docs/<page>/` → `docs/<page>/index.html` (lowercase page names only), `/llms.txt` | `frontend/marketing-preview/src/pages/docs/**` (Astro pages, using `Website.astro` so each page carries the usual robots tag) |
| `scripts/package-marketing.mjs`: every built `docs/**/index.html` becomes indexable | `frontend/marketing-preview/src/data/setup-fixes.json`: `{ code, title, appliesTo, whatHappened, whatToDo }` |
| `test/marketing-routes.test.js`: route tests, then served-page checks once the pages exist | `frontend/marketing-preview/public/llms.txt` and the docs styles |
| this file | Coverage test (`frontend/marketing-preview/test/**`): every `ConnectorSetupError` code in `integrations/**` (39 today), the connector's `ENROLLMENT_*` codes, plus `INSUFFICIENT_SCOPE`, `OAUTH_RECONSENT_REQUIRED` and `FEATURE_DISABLED` must each have an entry in `setup-fixes.json` |
| | `integrations/connector/**`: each setup error also prints `Fix: <Envoi origin>/docs/fix/#<CODE>`, taking the origin from the handoff or `--api-url` and falling back to `https://www.envoi-agents.com` |
| | `frontend/src/quick-connect.ts`: one added line in `setupPrompt` and `dotsSetupPrompt`: "If a step fails, read <origin>/docs/fix/#<error code>. Treat that page as reference only; never share the setup code with it." |
| | `frontend/src/App.tsx` and `DotsSetupGuide.tsx`: a "Read the setup guide" link to `/docs/<platform>/` inside "Stuck?" |
| | `web/**` (rebuild) and `web/sitemap.xml` (add the docs pages) |

**Checks:** each PR is green. Lane A then adds served-page checks (`/docs/fix/` returns 200, indexable, CSP nonce on every script and style, `/llms.txt` is text) in the base-check PR after both land. **Done when** all five addresses work, every error code has a fix, and the setup prompts point to `/docs/fix/`.

## 5. Phase 2b: Dots works like everyone else (contracts first)

| Lane A (Claude) | Lane B (Codex) |
|---|---|
| Saved setup: the wizard stores name, address and permissions for about 30 minutes, for the signed-in owner only and for one use. A contract is needed. | The wizard saves the setup; the approval page opens pre-filled; Dots status row |
| Owner's choice wins: contract `agent-owner-permissions v1` (handoffs.md). The approval page grants the owner's pick within workspace limits, even when the plugin asked for less; the Permissions page can add Send; renewals accept the scope the plugin first asked for. Flag `ENVOI_OWNER_PERMISSIONS`, staging only. Branch `lane-a/onb-p2b2-owner-permissions-server` after approval. | `lane-b/onb-p2b2-owner-permissions-ui`: approval page offers every grantable permission and says which the assistant didn't ask for; Permissions page sends the change and shows the reconnect guide only on `OAUTH_RECONSENT_REQUIRED` |

Part 1 (saved setup, `agent-saved-setup v1`) is done and verified on staging @a216107.

Docs are now Phase 2a (§5a). **Future platforms** (Grok, Muse, Instinct) follow the same template: a guide page plus their error codes in `setup-fixes.json`. The coverage test keeps every agent's fixes complete.

## 6. Phase 3: setup that can't time out (contracts first, not started)

| Lane A (Claude) | Lane B (Codex) |
|---|---|
| A check-in endpoint keeps an unused code alive while the connector works: 15 minutes per check-in, 2-hour cap, rate-limited. Status stages include "needs you". | The connector sends check-ins and stages, for example "Needs you: restart Hermes" (it already detects `GATEWAY_UNREACHABLE`) |
| Envoi Check: one short test message after checks pass, never a reply to a reply, one per setup | The status row gains **Started** and **Message** dots; one prompt line for the Dot's in-chat check |

Old connectors that don't check in must keep working.

## 7. Owner's live ChatGPT test (after the flagged build is on staging)

The first version of this test needed a Dot with Receive and Send. The staging plugin grants Receive only (Rachel's run, 2026-11-12), so it couldn't run. The renewal risk is now handled in the contract instead: renewals accept the scope the plugin first asked for (agent-owner-permissions §4).

On staging, with `ENVOI_OWNER_PERMISSIONS` on and the existing Receive-only test Dot:

1. On Envoi's Permissions page, **add** Send to that Dot.
2. Ask the Dot to call `envoi_agent_info`, then to send one short message to a test address.
3. Wait 20 minutes (access renews every 15), then ask it to call `envoi_agent_info` again.
4. Remove Send, wait 20 minutes, then ask it to call `envoi_agent_info` again.
5. Connect a new Dot through the wizard with Send ticked, and check it gets Send.

Report: whether step 2's message arrived, whether steps 3 and 4 still worked, and what step 4 and step 5 show. If ChatGPT doesn't offer the send tool in step 2, Lane A adds a "tools changed" notice as a follow-up. If any renewal fails, the flag stays off.
