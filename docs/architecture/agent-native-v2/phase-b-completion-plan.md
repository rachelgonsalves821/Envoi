# Phase B completion: connection routes and reliable wake

Prepared 2026-10-17 at integration `7442248d16635c2256c11bf02dcaf493ca4fe039`.
Status: remaining-work plan for review; no new contract, deployment or gate pass is established by this document.

## Objective and ownership

A user gives their agent `/connect`, approves its identity and permissions, and gets a truthful connection and background-availability result. Hermes, OpenClaw, Grok/xAI, Muse, Instinct and ChatGPT Dots remain named targets. Each needs its own verified route; an account that cannot integrate must have an explicit blocker and next action.

Je and his Claude session own Lane A: server, authorization contracts, persistence, provider callback handling, integration and evidence assembly. Rachel's Codex session owns Lane B: helper/client/runtime adapters, provider setup guidance, `/connect`, owner UI and client verification. Rachel remains the product/release approver; she does not need to implement server or client code manually. Human account consent, provider submissions and real-host operations use the existing approval rules.

This follows the [execution plan](claude-codex-build-plan.md) and [v3 §§31–47](build-plan-v3.md). One registration/claim/installation and durable queue serve all routes. Authentication and wake are separate acceptance results.

## Baseline and completion criteria

At the reviewed source baseline, the local-helper server/client and Gate B-local runbook are integrated. The board says the real-host local gate is pending; Je may have newer live evidence. Before assigning a fix, link his latest evidence and update its status. Do not repeat a completed run just because this planning snapshot predates it. The reported 207/207 stand-in-runtime validation belongs to `dcd2960`; it does not establish real-host acceptance at `7442248`.

Use these separate milestones:

1. **B-local accepted:** real Hermes and OpenClaw pass the existing 21-row local template on one candidate.
2. **B-hosted helper accepted:** repeat the applicable journey with hosted authentication, storage and route configuration, with exact release and artifact hashes.
3. **B-breadth accepted:** real remote MCP/OAuth, reviewed provider connector and portable REST acceptance, plus named-host connection and wake evidence.
4. **Full onboarding objective accepted:** every named host has the promised usable connection and background behavior, or Rachel explicitly approves a changed scope. Provider-blocked rows remain visible; they cannot be counted as passes.

Proven routes may ship to a limited cohort while others remain unavailable. Neither a limited cohort nor a B-local pass means all Phase B routes are finished.

## Remaining work and single owners

Task IDs below extend the backlog; they do not rename existing A-4/B-4 implementation tasks.

| ID | Accountable lead | Work and handoff | Acceptance |
| --- | --- | --- | --- |
| B-R1 | Je / Lane A | Finish or link B-local evidence; prepare hosted configuration and rollback. Rachel/Codex supplies real runtime observations and artifact hashes. | Existing local template and hosted helper gate have explicit results and human countersign; no inference from mocks. |
| B-R2 | Je / Lane A | Publish A-3.1b authorization contracts: OAuth consent/claim binding, PKCE, metadata, resource/audience/scope binding, redirect validation, renewal, revoke and approved provider bootstrap exception. | Client fixture ACK and human contract approval before implementation. Reuse existing registration/installation services. |
| B-R3 | Rachel / Lane B | Consume B-R2: route selection, MCP/provider client setup, private credential integration and safe recovery guidance. Je implements the approved server endpoints. | Real cloud-only host connects without local helper or operational secrets in model context; identity, inbox, send/reply, renewal and revoke pass. |
| B-R4 | Je / Lane A | Muse connector protocol/security design and provider submission package. Rachel/Codex owns tool descriptions, client behavior and actual-account setup observations. Rachel handles owner approvals/submission access. | Provider approval and a real Muse identity/inbox/send/reply exchange. Record write consent on each affected action; unavailable provider access remains blocked. |
| B-R5 | Je / Lane A | Instinct capability/route decision with actual account evidence and provider contact requirements. Rachel/Codex probes the supported client surface and writes the tested setup path. | A concrete supported authorization and execution interface, or a documented provider blocker. No assumed remote MCP support. |
| B-R6 | Je / Lane A | If B-R5 finds only email: propose the constrained email bridge contract, threat model, lifecycle and canonical receipt mapping for Rachel's approval. Rachel/Codex supplies the external-host interaction tests and guidance after approval. | Ownership proof, authenticated inbound handling, anti-spoof/loop protection, dedupe, case correlation, permission/pause/revoke enforcement and safe assets pass before real Instinct acceptance. Email arrival alone is insufficient. |
| B-R7 | Rachel / Lane B | Portable REST client and route guidance against Je's approved contract; actual Grok/xAI and Dots capability/authorization probes. Je owns server authorization and provider event subscription endpoints. | Generic HTTPS host runs without source checkout; named hosts each have real identity/exchange/renewal/revoke evidence. Name the precise Grok product/runtime tested. |
| B-R8 | Je / Lane A | Publish shared provider/HTTPS wake and subscription contract; implement canonical authenticated callbacks and durable delivery. Rachel/Codex implements runtime consumption, polling/restart behavior and truthful presence UI. | Per-host closed-app, outage, restart, pause/resume and revoke proof. Generic HTTPS security implementation is the shared Phase C C-A5 task, not a second adapter. |
| B-R9 | Rachel / Lane B | Finish usability/availability matrix and `/connect` instructions from server-published route status; use the existing packaging workstream's deliverables. | Fresh user follows the published flow without repository checkout or secret pasting; unavailable hosts explain the next supported step. Each automatic claim links to wake evidence. |

## Phase B named-host backlog — explicitly open (2026-10-18)

Prepared against freshly fetched `origin/integration/agent-native` at `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`. This preparation checkpoint does not change the acceptance status of any other route.

| Host / backlog | Status | Provider approval | Closed-app wake | Accountable lead / next action |
| --- | --- | --- | --- | --- |
| Muse / B-R4, B-R8 | **OPEN — blocked pending provider approval and real-host proof** | No Envoi approval artifact established by this evidence review. Submission, installation access and tool classifications must be recorded separately. | **UNTESTED / not accepted**; generic HTTPS receiver tests and open-chat calls do not prove Muse wake. | Je / Lane A: reviewed provider package and supported wake contract. Codex: [setup preparation](../../../integrations/onboarding/skill/PROVIDER-SETUP-PREPARATION.md); Rachel: account consent and provider submission. |
| Instinct / B-R5, conditional B-R6, B-R8 | **OPEN — blocked pending supported route/provider approval and real-host proof** | No supported Envoi integration approval established. Mailbox access is an account observation to verify, not authorization to operate an agent bridge. | **UNTESTED / not accepted**; email delivery is not agent processing or canonical reply. | Je / Lane A: route decision and contract publication. Codex: [email bridge review proposal](../../../integrations/onboarding/skill/INSTINCT-EMAIL-BRIDGE-PROPOSAL.md); Rachel: account consent and scope/contract review. |

The [dated evidence register](../../../integrations/onboarding/skill/PROVIDER-EVIDENCE-2026-10-18.md) records provenance, missing proof and the per-host acceptance worksheet. Both rows remain open through a limited beta for other verified routes. Neither provider submission, this proposal, generic adapter CI nor entry into Phase C closes full multi-host onboarding. An explicit Rachel-approved scope change must be recorded as a scope change, never as a host pass.

## Muse: required connection and wake work

- Validate the actual Muse account's connector interface and obtain required provider review. The existing compatibility matrix is the evidence starting point, not an acceptance certificate.
- Bind private authorization to the claimed Envoi installation. Prove identity, inbox fetch, send and reply in Muse itself, followed by renewal, reconnect and revoke.
- Classify send/reply correctly and test the provider's write-approval behavior. If every send requires human approval, report that constraint in setup and availability; do not describe unattended collaboration as accepted.
- Establish a supported incoming-event/subscription or scheduled execution mechanism. A remote tool that works in an open chat does not establish wake.
- Close the app/chat, send two separately approved items at different times, and verify one canonical effect/reply per item. Repeat outage/restart and lifecycle checks below. If Muse supplies no wake mechanism, keep background availability blocked and record the provider dependency.

## Instinct: required connection and wake work

- Inspect the supported interfaces available to Rachel's real account. Existing account feedback reports fixed integrations and an email mailbox; that is a lead for investigation, not a general claim about all Instinct versions.
- Prefer a provider-supported connector, MCP or authenticated REST route if verified. Establish secure credential custody and canonical Envoi identity before declaring a connection.
- If email is the only real route, B-R6 is a separate reviewed scope extension. Do not adapt a human mailbox into an agent installation without approved ownership, authorization, receipt and revocation semantics. Do not put a bearer credential in email.
- A bridge test must show the real Instinct host processes the incoming event while its app is closed and returns a reply that becomes exactly one authorized Envoi case event. Distinguish provider delivery from agent acknowledgement and processing; define which observations can actually be proved over email.
- Show what happens to queued and in-flight email work after pause and revoke, including late replies and attachments. Record any provider behavior Envoi cannot stop; do not claim control of unrelated external activity.
- If no secure route can meet this contract, retain an explicit provider blocker and proposed provider request. Completion requires a supported implementation or Rachel's explicit scope decision.

## Shared host acceptance record

Maintain one row per exact host/product/version and route with: owner, release SHA, helper/connector hashes, provider authorization, credential custody, identity/address, installation ID, owner claim, real tool/API exchange, wake mechanism, approval requirements, restart, renewal/recovery, pause/resume, revoke, status and evidence links. Include Hermes, OpenClaw, Grok/xAI, Muse, Instinct, Dots and a generic HTTPS client. Use untested, in progress, blocked, failed or passed with evidence; do not pre-fill a host as supported.

Every automatic host must prove:

1. Two approved incoming items at different times while its app/chat is closed; authenticated fetch and exactly one canonical reply per item.
2. Channel interruption and supported fallback, followed by runtime restart with the same authorized identity and no lost or duplicate work.
3. Credential renewal/lost-response recovery, pause with durable held work and explicit resume, then revoke with rejected late writes/settlement.
4. Duplicate notifications/replies, wrong tenant or expanded scope, and unscanned/ungranted file denial.
5. Visible receipts and truthful owner status. On-demand status/enrollment requires an approved contract revision; current registration v1 does not enable that mode.

Messages, faults, owner consent and destructive checkpoints follow the existing per-action approvals. This plan does not authorize live test traffic.

## Handoff into Phase C

Finish the current B-local run at its frozen candidate. Stage new route/authorization work on separate branches and integrate only after its contracts and checks pass. Never mutate a candidate in the middle of a gate.

Phase C contract design and fixture scaffolding may proceed in parallel. Before hosted C acceptance, name the accepted B routes used by that run and link their B evidence. Open Muse/Instinct work remains on this backlog with a single accountable lead; moving into C does not close it. The [Phase C plan](phase-c-execution-plan.md) owns the generic HTTPS adapter and case tools consumed by provider integrations.

Already claimed `integrations/distribution/**` packaging/background-service preparation stays with its existing Lane B workstream. Reuse its artifacts; request shared-path changes instead of duplicating its installer or supervisor.
