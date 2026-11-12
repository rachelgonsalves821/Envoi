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
| Owner's choice wins (Dots) | Approved **only if** the live ChatGPT test in §7 passes |
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
- [ ] Full CI on the combined base head, through the base-check PR (`lane-a/onb-p1-base-check`). This branch has no push CI.
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

## 5. Phase 2: Dots works like everyone else, plus docs (contracts first, not started)

| Lane A (Claude) | Lane B (Codex) |
|---|---|
| Saved setup: the wizard stores name, address and permissions for about 30 minutes, for the signed-in owner only and for one use. A contract is needed. | The wizard saves the setup; the approval page opens pre-filled; Dots status row |
| Owner's choice wins: the approval page grants the owner's pick within workspace limits, even when the plugin asked for less, and the Permissions page can add Send. Contract revision of agent-remote-auth, behind a flag. | Permissions page "Add send access" without the long guide |
| Serve the `/docs` route; a test fails if any setup error code has no fix section | Docs pages (guides, Problems and fixes, "Copy instructions for your agent", plain-text index); connector errors print `…/docs/fix#<CODE>` |

Docs rules:
- **Public, with only user steps and fixes.** No architecture, no prompt internals, no secrets, never the setup code.
- **Safety rules stay inside the prompt.**
- **Every new platform follows the same template:** a guide page plus its error codes. The coverage test keeps future agents' fixes complete. The connector has 39 error codes today.

## 6. Phase 3: setup that can't time out (contracts first, not started)

| Lane A (Claude) | Lane B (Codex) |
|---|---|
| A check-in endpoint keeps an unused code alive while the connector works: 15 minutes per check-in, 2-hour cap, rate-limited. Status stages include "needs you". | The connector sends check-ins and stages, for example "Needs you: restart Hermes" (it already detects `GATEWAY_UNREACHABLE`) |
| Envoi Check: one short test message after checks pass, never a reply to a reply, one per setup | The status row gains **Started** and **Message** dots; one prompt line for the Dot's in-chat check |

Old connectors that don't check in must keep working.

## 7. Before Phase 2: owner's live ChatGPT test (no code needed)

On staging, with a test Dot (it may disconnect; that is the answer we need):

1. Connect normally. On Envoi's approval page, note the **Requested permissions** line.
2. Ask the Dot to call `envoi_agent_info` and confirm it lists Receive and Send.
3. On Envoi's Permissions page, **remove** Send from that Dot.
4. Wait 20 minutes (access renews every 15), then ask the Dot to call `envoi_agent_info` again.
5. Report three things: what step 1 showed, whether step 4 still worked, and whether it now shows Receive only.

If step 4 works, ChatGPT accepts changed permissions on renewal, and "owner's choice wins" is safe to build. If it fails, Lane A fixes renewal first.
