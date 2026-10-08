# Envoi — instructions for Codex

This file is for **Codex, which is Lane B** (connector, SDK, runtime adapters, onboarding UI) in the agent-native build. Claude Code is Lane A and follows `CLAUDE.md` instead. The human (pjsk02) is the only approver.

Read before every task: `docs/architecture/agent-native-v2/claude-codex-build-plan.md` (precedence §0–§1, your paths §2, protocol §4, loop rules §5, task graph §6).

Hard rules:
- Edit only Lane B paths (plan §2). Never edit `src/**`, `db/**`, `test/contract-fixtures/**` or `handoffs.md`. Report contract problems as `MISMATCH` with expected versus observed, and request root-config changes with `REQUEST lane-a`.
- Work in your own worktree. Never use the primary checkout `D:\vsc\NEU\Sinaloa`.
- Branch from `integration/agent-native`. Open draft PRs into it, never into `main`.
- Generated `web/**` files come only from `npm run build`. Never hand-merge them.
- Never merge, deploy, close PRs or change settings. Post `BLOCKED` instead.
- Only code against contracts with `CONTRACT-APPROVED` from the human. Fixture-only scaffolding may start after `CONTRACT-PUBLISHED`.
- Run tests from PowerShell, not Git Bash.
- At session start: `git fetch origin`, then `gh issue view <build-board> --comments`.
