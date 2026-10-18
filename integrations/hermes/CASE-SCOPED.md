# Hermes case-scoped adapter: implementation and admission boundary

## Current status

The private MCP binding, loopback relay, standalone Node stdio shim and ACP stream
transport are implemented locally. They are not connected to the production
Hermes runtime entry point. Passing their tests is not a real-host gate result.
The existing manual/installer bridge remains unchanged.

The transport consumes the approved `case-session` / `case-tools` publication at
`15fff09f336fe941858287511471b07b9f5184f8`. Each binding captures one trusted
`ScopedModelTurn` and permanently disconnects on loss of authority. It never
retargets an old capability to a replacement case or session. Operational tokens
remain outside model input. ACP updates are observations, not instructions to
dispatch tools or send messages. Hermes Responses function-call output must not
be interpreted as pending client tools: that provider path already executes them.

## Pinned provider limitation

Source review at Hermes
`ccc695635094d7615373db267b77f894d978b1a0` found no supported per-session ACP
setting that both restricts the complete effective model tool inventory to the
captured private MCP tools and exposes that inventory before execution.
This is a source-level finding, not a reproduced live runtime failure and not a
claim about every Hermes release.

- [Session policy](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_policy.py)
  checks explicit toolsets as a subset of the effective tools, not an exclusive
  allowlist. Profile/plugin/native additions can survive an empty explicit list.
- [Editor policy](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_local_editor.py)
  accepts MCP servers and edit-approval policy, not a complete tool allowlist.
- [Worker selection](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_managed_worker.py),
  [worker execution](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/agent/managed_worker.py)
  and [editor MCP custody](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_local_mcp.py)
  do not make `safe_mode` or `ignore_user_config` a working substitute: the
  bypass worker does not supply the authority needed to recover private editor
  transports. Safe-mode discovery also disables MCP registration.
- [Tool Search](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/tools/tool_search.py)
  can replace the MCP catalog with synthetic search/describe/call tools. Its
  configuration must be included in any reviewed exclusive-inventory solution.
- Pre-turn `session.info` / `tools.show` inspection does not establish the full
  editor overlay used during execution. A fingerprint, successful MCP discovery,
  restricted-profile assertion or prompt instruction is not equivalent proof.

Do not enable this route by relaxing the exclusive-tool requirement. Do not
invent an ACP inventory method or silently use the legacy privileged relay.

## Unblocking requirements

Before runtime wiring can be accepted, identify a reviewed provider version or
separately approved runtime design that supplies all of the following:

1. An authoritative tool-selection boundary applied at model construction and
   refresh, including native tools, plugins, configured MCP and Tool Search.
2. A pre-execution projection of that same effective inventory, including the
   private editor MCP overlay. Compare actual names and schemas with the captured
   turn, and refuse extra, missing or changed tools before model execution.
3. A non-starting readiness check tied to the selected profile. Discover the
   endpoint first and connect explicitly; do not use discovery helpers that can
   start a daemon as a side effect.
4. A private durable provider-turn journal and recovery path. Preserve operation
   keys and uncertain outcomes; never resample an uncertain successful write.
5. Cancellation that invalidates the MCP binding first, then cancels the captured
   provider session and waits a bounded time for its terminal response. Closing
   an ACP viewer alone is not proof that daemon execution stopped.
6. Matching-release real-host evidence for parallel cases, decisions, assets,
   recovery and revocation, with separately approved live operations.

No current helper starts Hermes, changes a profile, enrolls an agent, sends test
work or changes the original paused case merely to obtain evidence.

## Local checks

Run from PowerShell in the isolated task checkout:

```powershell
npx vitest run --config integrations/vitest.config.ts integrations/hermes/scoped-mcp.test.ts integrations/hermes/scoped-relay.test.ts integrations/hermes/scoped-acp.test.ts
npm run test:integrations
npm run test:sdk:typescript
npm run typecheck
git diff --check
```

The standalone stdio and ACP tests use synthetic Node child processes and local
streams, not Hermes. Their results establish transport behavior only. Server,
database, combined CI and hosted acceptance must be recorded separately.
