# B-3.1 runtime-neutral onboarding review

Initial review completed on 2026-10-11 (America/Toronto). The 2026-10-12 follow-up revises this design-only kit after Lane A review of the multi-route plan in PR #75. Its static planner now distinguishes the connection route from delivery/wake mode; this is not a server contract or live feature.

The GitHub connector rejected PR metadata changes with HTTP 403, so this file carries the updated review description for existing draft PR #72. The PR conversation text may still describe the earlier six-check static package.

A host that reads Envoi's skill still needs a reviewed connection route, private operational credential storage and separate wake proof. This B-3.1 draft includes an executable local manifest/capability consumer and conformance kit: Muse, Instinct, ChatGPT Dots and arbitrary agents use identical capability selection, with runtime name treated as metadata. It reuses the existing skill package.

- Task/lane: B-3.1a design only, Lane B. This PR has not been rebased onto the latest integration head; live feature work must start from a fresh exact base after the core contract is approved.
- Changed paths: integrations/onboarding/** plus the pre-existing integrations/gates/PHASE-A-HOSTED-PREP.md worksheet. This update touches only onboarding; #73's hosted fixture is separate.
- Contract consumed: v3 §§30–47 and §54 design constraints; approved a3-pause-auth v2, a4-wake v1, a5-presence v1 lifecycle constraints. No new server wire fields or Lane A edits.
- Compatibility: same manifest and claim/installation boundary for every runtime. The draft planner selects local-helper, remote MCP/OAuth, reviewed provider connector or authenticated REST only from observed capabilities. Candidate provider/webhook/SSE/poll flags alone classify as on demand. A background mode requires all eight conformance checks and matching host/version/release/integration references. Missing private storage/HTTPS or any reviewed connection route is unsupported.
- Live gate: every supported plan returns contract_blocked and liveEnrollmentAllowed:false. Phase B contracts are unpublished/unapproved. skill.json remains published:false. No registration, activation, helper execution, network call, deployment or publication occurs.

Local entry point (schema `host-plan-draft-2`):
node integrations/onboarding/host-plan.mjs integrations/onboarding/profiles/unverified-host.json

The seed correctly reports unsupported_host. A trusted host may supply observed capabilities and private evidence using skill/HOST-INTEGRATION.md. Output includes only fixed safe planning fields and a planned executable/argument array; it never echoes evidence URLs or raw input. Evidence checks validate references only, not their authenticity or a real host run.

Validation at this tree:
- node --test integrations/onboarding/test/*.test.mjs: 19/19 on the 2026-10-12 follow-up.
- npm run typecheck: PASS.
- npm run test:integrations: 200 PASS / 1 existing skip, including the onboarding Node suite through Vitest/CI. Windows sandbox temp-file loading failed before tests; the unchanged suite passed outside the sandbox.
- npm run test:frontend: 246 PASS.
- npm run test:sdk:typescript: 188 PASS.
- npm run test:sdk:python: 6 PASS.
- git diff --check: PASS.
- CI for the updated head: pending; the earlier head's CI is not evidence for this update.

Hosted evidence: all actual runtime capabilities and Phase B wake/reply acceptance remain UNPROVEN. Synthetic tests do not establish Muse/Instinct/Dots vendor features. Real Hermes/OpenClaw Phase B acceptance and each additional host's closed-app wake/reply, restart, duplicate, pause, revocation and secret-isolation observations remain required.

REQUEST lane-a: publish A-3.1a route-neutral registration/claim/installation fixtures and status/error/idempotency semantics first, then A-3.1b remote MCP/OAuth and reviewed provider authorization. The OAuth consent page must perform the owner claim; a secure-field fallback carries only a single-use bootstrap code. Publish feature-flag behavior, safe model-visible output and reachability projection, including the future On demand presence label. Human contract approval is required before live route implementation. Exact decisions are in integrations/onboarding/skill/HOST-INTEGRATION.md.

Rollback: remove this isolated draft package, baseline ef6c4f46454599e91e9edb79379a2ce414b1962f. No live behavior changes. Build-board comment could not be posted: GitHub connector returned 403 Resource not accessible by integration.
