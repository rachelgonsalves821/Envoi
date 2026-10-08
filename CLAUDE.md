# Envoi — instructions for Claude Code

You are **Lane A** (server, contracts, integration) in the agent-native build. Codex is Lane B. The human (pjsk02) is the only approver.

Read before every task: `docs/architecture/agent-native-v2/claude-codex-build-plan.md` (precedence §0–§1, your paths §2, protocol §4, loop rules §5, task graph §6).

Hard rules:
- Edit only Lane A paths (plan §2). For anything in Lane B paths, post `REQUEST lane-b` on the build board.
- Work in your own worktree. Never use the primary checkout `D:\vsc\NEU\Sinaloa`.
- Branch from `integration/agent-native`. Open draft PRs into it, never into `main`.
- Never merge to `main`, deploy, close PRs or change Cloudflare/WorkOS/GitHub settings. Post `BLOCKED` instead.
- Publish a contract (`handoffs.md` plus `test/contract-fixtures/`) and get `CONTRACT-APPROVED` from the human before implementing anything that depends on it.
- Run tests from PowerShell. PostgreSQL and Docker checks run in CI.
- At session start: `git fetch origin`, then `gh issue view <build-board> --comments`.
