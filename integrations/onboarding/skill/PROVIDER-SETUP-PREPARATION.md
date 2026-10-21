# Muse and Instinct provider setup preparation

Prepared 2026-10-18 from integration `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`. Status: **draft preparation; both hosts OPEN**. This is an operator/reviewer checklist, not a published installation flow. See the [evidence register](PROVIDER-EVIDENCE-2026-10-18.md) and [Phase B backlog](../../../docs/architecture/agent-native-v2/phase-b-completion-plan.md).

## Muse / B-R4 and B-R8

Prepare these review materials before Rachel opens a provider submission. Nothing has been submitted by this task.

| Material | Preparation / outstanding input | Owner |
| --- | --- | --- |
| Use case | Two owner-approved agents exchange work in canonical Envoi cases; describe exact permitted actions and separate delivery from processing. State that automatic availability is unverified. | Codex draft; Je confirms actual contract |
| Organization and contacts | Business/brand authority, product terms, privacy policy, support/security contact and maintenance owner must be supplied and reviewed. Do not invent a company identity or partnership. | Rachel |
| Endpoint/auth/scopes | Pin approved contract/version, hosted test endpoint, account/installation binding, least-privilege scopes, renewal/revoke and private secret custody. These are required inputs, not an assertion that this candidate implements a provider-compatible flow. | Je |
| Read-only consent and denial | Document an OAuth read-only option where possible, with reads separated from claim/settlement and send mutations. Include denied consent, denied writes and changed-action approval checks; neither account linking nor read consent grants write authority. | Codex prepares cases; Je confirms enforcement |
| Tool catalog | Proposed categories below; provide exact approved tool names, schemas, errors, rate limits and side effects from the reviewed contract before submission. | Codex with Je contract review |
| Dedicated reviewer account/demo | Synthetic cases, restricted test scope, secure credentials supplied through the provider's intake; observed consent/failure/retry behavior. Account creation and live demo remain future steps. | Rachel authorizes; Codex prepares instructions |
| Data handling | Document actual collection, recipients, retention/deletion, credential storage and incident response. Match deployed behavior and published policy. | Je technical facts; Rachel approves statements |
| Review tracking | Portal review ID, date, requested/approved tools, conditions and rejection/follow-up history. Preparation is not submission or approval. | Rachel |

Proposed tool descriptions for review, not executable tool definitions:

| Operation family | Description / effect | Proposed classification |
| --- | --- | --- |
| Identity, inbox and bounded case reads | Return only the authorized installation's identity and permitted canonical data. No hidden mutations. | Read; separate any lease/claim mutation |
| Claim, renew, acknowledge, settle | Change work ownership or lifecycle; describe leases, effects and failure handling explicitly. | Write; provider determines sensitivity |
| Start case, send, reply | Create a canonical case/message for the approved recipient and content. Return a durable receipt; it does not imply the recipient processed it. | Write; request explicit provider sensitive classification |
| Request owner decision | Create a request for the authorized owner. Never fabricate an owner decision or imply that a model reply is approval. | Write; separately review consent requirements |

[Muse's guidelines](https://platform.muse.ai/docs) require per-use approval for sensitive writes. Keep send/reply sensitivity pending the provider's determination. An account link, broad initial consent or scheduled goal cannot waive required prompts. Record wake and permission to reply separately; a host may wake but be unable to reply unattended.

Provider capability questions to include in the reviewed packet: Which auth/discovery flow is accepted? Is a private connector install available to this account? What event or scheduled mechanism may invoke an authorized connector while the app is closed? What are delivery/retry, duplicate, restart, cadence and rate-limit guarantees? Does it start execution or only add context? Which tools need approval every time? How are pause and revocation propagated?

When provider access and the applicable contracts are approved, inspect the real account's UI and record its exact connector path; then follow the common owner claim flow. Verify identity/read operations, authorized send/reply, renewal/reconnect and revoke in a disposable environment. Test read-only restrictions, deny a requested write, and change an approved action's recipient/content/scope: denied or stale approval must cause no effect, and changed details require fresh approval. Conduct the separate two-item closed-app gate only with its own authorized traffic and frozen candidate, including a lost notification and supported catch-up without reopening the app. Do not publish a guessed setup URL, expose operational tokens to the model, or enable unsupported route modes.

## Instinct / B-R5, conditional B-R6 and B-R8

1. Obtain redacted actual-account observations: exact product/build/plan/region, integrations available, whether an assistant-specific mailbox exists, and any native developer or private-credential interface. A personal email integration is not automatically an assistant mailbox or agent identity.
2. Ask the provider for supported custom connector/MCP/REST authorization, third-party automation eligibility, credential custody, incoming-event execution, approval behavior, review requirements, rate limits and lifecycle guarantees. Use an owner-approved support channel after review; this task sends no inquiry.
3. Prefer a verified native route. If only email remains, review the [constrained email bridge proposal](INSTINCT-EMAIL-BRIDGE-PROPOSAL.md). Decide whether the provider can support opaque notification plus authenticated fetch, or only a content-bearing conversation bridge. No bearer/bootstrap credential belongs in email.
4. Obtain provider permission/approval for the selected use and Rachel's explicit contract/scope decision. Je publishes the concrete server contract and fixtures; Codex reviews client implications. An accepted proposal does not itself authorize implementation, installation or live tests.
5. Plan a disposable account/case pair, synthetic content, verified mailbox binding, privacy disclosure, restricted evidence storage, and reversible test configuration. After implementation and separate run authorization, verify both app-closed items, canonical correlation, duplicates/restart, pause/resume, revoke and late replies. Preserve a visible blocker if the provider cannot meet these requirements.

Draft provider inquiry for review (not sent):

> We are evaluating an owner-authorized Envoi integration for an Instinct assistant. Which supported third-party interface can bind one assistant to a private, revocable installation? If email is the only available route, may a verified assistant mailbox receive synthetic work notices and return machine-correlated replies while the app is closed? Please specify sender-authentication guarantees, approval requirements, reply correlation, unattended-execution limits, data handling, and pause/revocation constraints. We will not treat mailbox delivery as execution or use private browser APIs. Please identify any provider review required before a test.

## Decision record to complete at review

Record the chosen host/version, supported route, provider approval reference, approved tool scope, authority/custody model, wake mechanism, known limits, approved contract and fixture versions, consent requirements and owner decision/date. Until supplied, keep both hosts unavailable/unverified in evidence. These documents add no API, registration enum, capability flag, presence label, installation or runtime. Limited-beta scope for other verified routes remains separate from full named-host completion.
