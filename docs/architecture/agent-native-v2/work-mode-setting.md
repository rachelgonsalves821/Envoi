# Work mode setting: plan and lane split

**Prepared:** 2026-11-15 by Lane A · **Approver:** the owner (pjsk02) · **Contract:** `agent-work-mode v1` (handoffs.md)

## 1. Why

On 2026-11-15 Mark's background receiving came on only after the owner pasted two long prompts into the Dot. The Copy fix instructions prompt also sent the Dot down the wrong path twice:
- it tried to restore an old task that Envoi shows was never subscribed for Mark;
- it refused to create a monitor because ChatGPT exposes no unsubscribe for the old task.

The owner wants to choose once, on the agent's page in Envoi.

**Constraint.** For a Dot, ChatGPT owns the monitor and its callback secret, and nothing runs until something wakes the Dot. So Envoi can switch background receiving **off** by itself, but switching **on** needs the Dot to run once. Connector agents (OpenClaw, Hermes) run all the time, so both directions take effect without that.

## 2. Decisions (owner, 2026-11-15)

- **One setting per agent in Envoi:** "When messages arrive". The options are **Handle routine work, ask me for important decisions** (default), **Always ask me first**, and **Off (only when I ask)**.
- **Off** takes effect immediately from Envoi.
- **On** for a Dot needs one short message ("Sync with Envoi") instead of a long prompt. Connectors apply it by themselves.
- The two prompt fixes from Mark's case go into the new skill wording:
  - never reuse or restore a task that Envoi shows no subscription for;
  - never block creating a monitor on an unsubscribe ChatGPT doesn't expose.

## 3. Branches

- `main` @90c50e3 is live. The onboarding base is fully merged into `main`.
- Task branches start from `origin/main`:
  - Lane A: `lane-a/onb-p5-work-mode-contract` (this PR), then `lane-a/onb-p5-work-mode-server`;
  - Lane B: `lane-b/onb-p5-work-mode`.
- Draft PRs go into `onboarding/simple-setup`. **Owner first:** fast-forward the base to `main` (`git push origin origin/main:refs/heads/onboarding/simple-setup`) if it is behind.
- Lane A runs full CI on the combined base. The owner merges the base into `main` and deploys.

## 4. File ownership (no overlap)

| Lane A (Claude) | Lane B (Codex) |
| --- | --- |
| `src/server.js` (route, owner views, `/api/agent/status`, claim filter), `src/agent-mcp.js` (`envoi_agent_info`), `src/provider-event-wake.js` (subscribe guard), new `src/agent-work-mode.js` | `frontend/src/**` (agent page setting, wizard save, sync message), `frontend/test/**` |
| `worker/runtime-config.js` (forward `ENVOI_WORK_MODE`), `wrangler.jsonc` (staging `true`, beta unset), `scripts/check-deployment.mjs` | `integrations/onboarding/remote-mcp-oauth/plugin/skills/envoi-dots-setup/SKILL.md` (1.0.9) |
| `test/contract-fixtures/agent-work-mode/**`, `test/contract-agent-work-mode.test.js`, `test/agent-work-mode.test.js`, `handoffs.md`, this plan | `integrations/agent-bridges/bridge.ts` and the connectors' status read, their tests, the docs pages (`docs/dots`, `docs/fix`), generated `web/**` |

## 5. Tasks

### Lane A (Claude)

- **W-A1. Contract `agent-work-mode v1`** (this PR): 14 fixtures; the flag `ENVOI_WORK_MODE` is off by default.
- **W-A2. Server**, after `CONTRACT-APPROVED`:
  - the mode store (agent document field, no migration);
  - the PUT route;
  - the Off transaction, which ends live `mcp_events` subscriptions with `ended_by_owner`;
  - `workMode` in owner views, `envoi_agent_info` and `/api/agent/status`;
  - the subscribe guard (`-32016`);
  - the connector claim filter;
  - forwarding the flag in `CONTAINER_ENV_KEYS`, plus `check-deployment`. A missing forward hid `ENVOI_SAVED_SETUP` on staging once.
  - Before publishing behaviour changes, grep `frontend/test` for server-pairing tests. That is the #386 lesson.
- **W-A3.** Integration and full CI. Staging gets the flag on; beta stays off until the hosted check passes.

### Lane B (Codex)

**W-B1. Agent page setting**
- A "When messages arrive" control on each agent, for agents in workspaces the human manages. It shows the three modes with a one-line explanation each and saves with `PUT …/work-mode`.
- **Dot in `routine` or `ask` that isn't listening:** replace the listening banner's long prompt with "Waiting for {name} to turn it on" and **Copy sync message**. That copies one line: `Sync with Envoi for {address}`.
- **`off`:** show "Off: {name} only works when you ask" for Dots, or "Off: {name} only handles your instructions" for connectors. No listening banner.
- **Field missing (flag off or older server):** keep today's banner and Copy fix instructions.

**W-B2. Setup wizard**
- The existing Dots "When messages arrive" radio (`routine` / `ask` / `on_demand`) maps `on_demand` to `off`.
- Once the saved setup reaches **Connected** and has `agent.id`, the wizard saves the choice with `PUT …/work-mode`.
- The generated setup prompt stays as it is.

**W-B3. Dots skill 1.0.9 and prompts**
- Handle "Sync with Envoi" and the start of every run. Call `envoi_agent_info`, then act on `workMode.mode`:
  - `off`: disable its own monitor task. No unsubscribe is needed; Envoi already ended the subscription.
  - `routine` or `ask`, not listening: create exactly one monitor with that mode's rule (§6 of `proactive-agents.md`).
- Never treat a task as matching, or restore it, when Envoi shows no subscription for this address.
- Never block creation because ChatGPT exposes no unsubscribe for an old task. Pause the old task and continue.
- `-32016 BackgroundReceivingOff` on subscribe: tell the owner background receiving is off in Envoi, and don't retry.
- Ready only when `state: on` and `lastAlertAt` is set (unchanged).

**W-B4. Connectors and docs**
- The bridge reads `workMode` from `GET /api/agent/status`, at most every 60 seconds, and uses the matching rule text.
- `off` needs no bridge change: the server stops offering peer work.
- Docs:
  - `docs/dots`: a short "When messages arrive" section.
  - `docs/fix`: one entry, `#background-receiving-off`, for the `-32016` result.
  - Rebuild `web/`.

### Owner (human-only)

1. Fast-forward the base if needed (§3).
2. Post `CONTRACT-APPROVED agent-work-mode v1` after Codex's `CONTRACT-ACK`.
3. Merge the base into `main` and deploy staging.
4. Upload skill 1.0.9 for the staging Dot, then run §6.
5. Decide whether beta gets `ENVOI_WORK_MODE`, then upload 1.0.9 to Envoi production.

## 6. Hosted check (staging Dot "Jack" and an OpenClaw agent)

1. Set Jack to **Off** in Envoi. Its badge turns **Off**, and a message to Jack does not wake the Dot.
2. Set Jack to **Handle routine work**. Envoi shows "Waiting for Jack to turn it on". Send the copied sync line. Jack creates one monitor, gets the first alert and says Ready. The badge turns **On**.
3. Set Jack to **Always ask me first**. On its next run, Jack asks before replying to a new message.
4. Set the OpenClaw agent to **Off**. Peer messages wait in its inbox, and an owner instruction is still handled.

## 7. Not in this change

- Grok targets.
- Per-contact or per-case modes.
- Owner notifications outside Envoi and the Dot.
- Turning a Dot's monitor on without any Dot run. ChatGPT doesn't allow it.
