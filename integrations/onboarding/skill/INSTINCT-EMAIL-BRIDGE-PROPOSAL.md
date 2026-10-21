# Instinct email bridge — proposal for review

Date: 2026-10-18. Base: integration `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`. Task: B-R5 / conditional B-R6 / B-R8. **DRAFT; no contract approval, implementation or live experiment. Instinct remains OPEN pending provider approval and closed-app wake proof.**

Rachel requested this review proposal. Je remains accountable for the route/security decision and Lane A contract publication; Codex prepares client interaction/evidence guidance. This document neither modifies canonical contracts nor asserts a fifth registration mode. It supersedes no approved API. [Phase B requirements](../../../docs/architecture/agent-native-v2/phase-b-completion-plan.md) and the [evidence register](PROVIDER-EVIDENCE-2026-10-18.md) govern acceptance.

## Route decision

First inspect the actual account and seek a supported native connector/MCP/REST interface. Email is conditional on that investigation, provider permission and separate scope/contract approval. Never use reverse-engineered browser APIs or mailbox access as a substitute for installation authorization.

| Candidate | Flow | Required proof / limit |
| --- | --- | --- |
| A: email notification with native tools, preferred if supported | Bridge sends only an opaque notice. Real Instinct authenticates, fetches canonical work and acts through the approved Envoi contract. | Needs a real private auth/tool interface plus provider-supported email invocation. Email alone cannot supply it. |
| B: constrained email conversation bridge, conditional fallback | Trusted bridge mediates a specifically authorized canonical exchange over a verified assistant mailbox. Instinct returns content; bridge validates and applies an allowed action. | Email is not native tool authentication. Requires secure provenance/correlation, explicit content-sharing consent and a new reviewed authority contract. It may remain infeasible. |

Approve a feasibility/design direction first; do not present either as supported. Candidate B cannot satisfy native authenticated-tool evidence. Whether its narrower bridge-mediated proof can satisfy the full named-host promise requires Rachel's explicit scope decision, recorded distinctly from a host pass.

## Trust and ownership

Proposed binding: one owner, tenant, Envoi agent, installation, verified Instinct assistant mailbox and lifecycle generation. The bridge is a trusted service principal acting only for that installation; it is not the human owner and not an authenticated Instinct tool client. It cannot mint human decisions, broaden permissions, impersonate unrelated agents or enroll a mailbox as a human contact.

Mailbox challenge plus confirmation in an authenticated Envoi owner session can establish control of a delivery endpoint. It does **not** establish that the endpoint belongs to the intended Instinct runtime. Require separate actual-account/provider evidence of the assistant mailbox and permitted automation. Binding changes invalidate prior challenges, correlations and in-flight authority. Challenge delivery conveys no Envoi read/write authority and must be purpose-bound, expiring, single-use and absent from logs; exact mechanism/TTL require Lane A review.

Provider service credentials and Envoi installation credentials stay in private trusted storage outside email and model context. Use a distinct least-privilege bridge principal, rotation and revocation. No operational bearer, bootstrap code, asset URL with authority, reusable reply credential or broad access link goes in a message. Any SMTP reply alias/correlation value is routing metadata, never sufficient authorization by itself.

## Proposed end-to-end flow

1. Owner explicitly authorizes the selected route, mailbox and permitted peers/actions. Candidate B additionally discloses which synthetic case content leaves Envoi, recipients, retention and external-provider deletion limits. Initial pilot is text-only, bounded, disposable and synthetic. No general email composer or arbitrary-recipient tool.
2. Existing canonical authorization accepts peer work and persists it in Envoi. Durable dispatch intent is keyed to installation, work and lifecycle generation. The bridge must reuse the canonical queue/ordering/permission services; a transport ledger records attempts and correlation, not a second inbox or conversation store.
3. Immediately before dispatch, recheck installation status, tenant/agent, peer permission, case control and current work authority. Candidate A sends an opaque identifier only. Candidate B may send only the approved minimum text after its explicit data-disclosure decision; never send credentials, embedded remote media, attachments or reusable fetch links. This difference from opaque wake is a review decision, not a silent fallback.
4. Authenticate ingress from the selected mail provider using its documented raw-body webhook verification, freshness and replay controls. Verify the intended recipient endpoint, envelope sender, aligned sender-authentication evidence supplied by the trusted provider, mailbox binding and exact reply correlation. Ignore client-supplied authentication headers unless the provider verifies and attests them. A webhook signature authenticates the mail service, not Instinct authorship; SPF/DKIM/DMARC alone do not establish owner consent or agent execution. Require provider-backed provenance for automatic canonical writes. If that is unavailable, quarantine for owner review and leave automatic bridge acceptance blocked.
5. Treat mail subject, body, display name, Message-ID and threading headers as untrusted. Resolve one active server-side correlation to one tenant/installation/agent/case/work/generation; never derive authority from a case ID in text. Reject wrong recipient, forwarding, ambiguous or missing correlation, multiple destinations and stale generations. Do not create new cases from arbitrary unsolicited mail. Quoted instructions cannot grant authority.
6. Parse only an explicitly defined bounded reply format. Exclude quoted history, signatures, vacation notices, delivery reports and unsupported MIME; ambiguity is quarantine, not a guessed reply. A legitimate automated Instinct response must remain eligible when its provenance, correlation and permitted reply format pass; an automation header alone neither grants authority nor rejects the intended assistant response. Map one allowed reply to an existing canonical action with a stable logical-effect key. Check lifecycle, permissions, case scope and current claim/fence atomically at the effect boundary. Email cannot hold a long-lived lease: Je must define dispatch ownership and fresh revalidation under the approved work contract. An expired lease or changed installation cannot be revived by late email.
7. Persist the inbound ledger result, canonical message effect and settlement consistently using the canonical idempotency/fencing rules. A crash after canonical reply but before acknowledgement must recover to that same effect; repeated email/webhooks or changed mail Message-IDs must not produce a second reply. Reconcile outcome before retrying ambiguous writes. Any receipt/acknowledgement email must be loop-safe and separately authorized; default to no email auto-acknowledgement.

No endpoint paths, new fields, provider header names or error schemas here are an approved contract. Lane A must publish exact supported primitives, durable state and fixtures before dependent implementation.

For the initial text-only bridge, each canonical work item permits at most one reply effect across all transport attempts and replacement correlations. The first valid reply consumes that logical reply slot atomically; later duplicates resolve to the same receipt, while different late content is quarantined without overwriting or adding an effect. A new Message-ID, retry alias or dispatcher restart must not create a new slot. Additional conversational turns require new authorized canonical work. The reviewed contract must bind any action consent to the exact recipient, content and scope; changed details require fresh approval. No email text can stand in for that approval.

## Threat model and required controls

| Threat | Proposed requirement | Proof needed before live acceptance |
| --- | --- | --- |
| Forged/forwarded mail or stolen correlation | Verified provider ingress plus authoritative mailbox provenance and scoped server correlation; metadata never grants authority | Spoofed From, forged auth headers, valid webhook containing wrong sender, forwarded and wrong-recipient tests all produce no canonical effect |
| Cross-tenant/cross-case injection | Exact installation/tenant/case/work binding; deny expanded scope even for a valid sender | Two owners and simultaneous cases cannot cross-route |
| Prompt injection / forged human approval | Mail is untrusted content; allowlisted typed effects only, human decisions remain authenticated owner operations | Text requesting secret access, permission escalation or fabricated approval cannot change authority |
| Replay/duplicate/reordered replies | Durable provider-event and logical-effect dedupe, lifecycle generation, current fence and sequence checks | Replayed webhook, new Message-ID for same reply, restart and two concurrent deliveries yield at most one authorized effect |
| Mail loops and floods | Reject bounces, delivery reports, vacation/list responses and self-originated notices; admit only authenticated, correlated assistant replies under the bounded format; apply per-installation quotas, retry budgets and no auto-acknowledgement | A legitimate automated assistant reply is accepted once; vacation/bounce/self-echo and repeated assistant-to-ack loops cannot create further effects or peer amplification |
| HTML/MIME abuse and assets | Text-only initial scope, bounded bytes/parts/encoding, no remote loading; deny attachments | Oversize/malformed MIME, remote image and attachment cause no fetch or executable effect |
| Secret/content disclosure | No credentials in mail/logs; minimal owner-approved text only for B; restricted evidence retention | Redacted logs and explicit data path review; no hidden content-bearing fallback |
| Revocation/TOCTOU | Fresh authority at dispatch and transactionally at reply/effect/settlement; retire old correlations | Pause/revoke racing send/reply cannot commit unauthorized late effects |

Exact bounds, freshness windows, retry/backoff limits, correlation expiry, retention/deletion and mailbox normalization must be chosen and published by Lane A with fixtures. Preserve provider-specific mailbox identity; do not casually strip plus aliases, dots or case where the provider has not guaranteed equivalence. No route can be enabled with these decisions unresolved.

## Lifecycle and recovery

| Event | Required Envoi behavior | External limitation |
| --- | --- | --- |
| Pending setup | No work dispatch before owner claim, endpoint control and approved route binding | Mailbox verification is not host acceptance |
| Provider outage / delayed email | Bounded retries with stable logical dispatch identity; pending canonical work remains durable and visible; no false processed receipt | Delivery timing may be unknown; provider acceptance may be ambiguous |
| Bridge restart / lost response | Reload durable correlations and attempt ledger; reconcile canonical effect before retry; recheck lifecycle and leases | Do not resend content solely because an HTTP response was lost |
| Lost notification / exhausted retries | Reconcile pending canonical work independently of notification delivery using a supported bounded retry/check mechanism; expose exhausted attempts and an authorized recovery step without marking work processed | If the provider offers no reliable recovery/invocation path, keep automatic wake blocked; a second human prompt is not unattended recovery |
| Pause | Suppress new dispatch and reply/settlement effects; preserve held work and strict per-case ordering | Already sent mail cannot be recalled; Instinct may still act outside Envoi |
| Resume | Explicit owner action; revalidate authority and reoffer held work through canonical services; use fresh correlations where needed | Old replies must not silently regain authority |
| Revoke | Stop dispatch, invalidate principal/binding/correlations, reject late writes/settlement, retain only required restricted audit/tombstones | Envoi cannot guarantee deletion or cessation of activity at the provider |
| Reconnect / mailbox change | New verified binding and lifecycle generation; no automatic reenrollment or replay of old capabilities | Prove the new endpoint separately |

During pause, late raw replies may enter a bounded restricted quarantine, but cannot become authorized case replies or settle work. Resume does not automatically commit quarantined replies; a newly authorized action must pass current checks. After revoke, discard/quarantine according to reviewed retention rules, with no canonical reply effect. Record races and operator-visible reasons without leaking content to unrelated tenants.

Attachments are outside the initial proposal. Any later extension needs existing upload quarantine/scanning and explicit case grants, MIME/size limits, no automatic external URL fetching, and pause/revoke enforcement. Email arrival or provider scanning does not satisfy Envoi's asset gate.

## Receipt semantics

| Observation | What it proves | What it cannot prove |
| --- | --- | --- |
| Envoi accepted peer work | Authorized canonical enqueue | Instinct saw it |
| SMTP/API accepted or delivered notice | Transport accepted/delivered according to provider evidence | Assistant read, woke or processed it |
| Authenticated correlated inbound email | Mail received with the verified provenance actually available | Native Instinct API identity, human approval, or completion of unrelated actions |
| Canonical reply accepted by bridge | Current authority permitted exactly one bridge-mediated case reply | Instinct has native tool support or is generally always available |
| Work settled | Canonical settlement accepted for current work authority | External actions were completed unless separately evidenced |

Do not invent a read receipt from tracking pixels. For candidate A, record actual Instinct-authenticated fetch/claim/reply. For B, disclose bridge mediation in the evidence and preserve source attribution in the reviewed server model; never label the email itself an authenticated tool call.

## Proposed acceptance gate and decisions

Before implementation: provider confirms eligible route and mailbox/ingress guarantees; Rachel decides A or conditional B, synthetic text sharing and whether B's narrower scope is acceptable; Je publishes exact authorization/lifecycle/receipt contract and executable fixtures; Codex reviews compatibility; Rachel approves the contract. Generic HTTPS receiver work is reused only where its contract applies, never counted as email/Instinct proof. The existing human-email adapter is not silently reused or enabled.

Offline fixtures must cover the threat and lifecycle matrix above, including crash-after-effect recovery, duplicate replies with different content/Message-IDs, legitimate automated assistant responses versus vacation/bounce loops, and race tests on supported stores. Before a separately authorized hosted run, freeze release SHA and artifacts, record account/version, provider permission and owner-approved test traffic. Use two independently timed app-closed items in distinct cases, no fresh owner prompting; verify one authorized canonical reply each, both-owner observations, interruption/restart, a deliberately lost notice and supported catch-up, renewal/recovery as applicable, duplicate suppression, pause/held/resume, revoke and rejected late replies. Choose and record latency criteria before running; approval prompts or provider delays remain visible constraints. See the [acceptance worksheet](PROVIDER-EVIDENCE-2026-10-18.md).

Keep Instinct open if secure provenance, supported authority, write approval or closed-app behavior cannot be proved. Quarantined owner-mediated mail may be useful for investigation but cannot pass unattended acceptance. Even provider-approved email delivery is insufficient to close the full onboarding requirement. No provider contact, account operation, mail send, deployment, live fault, flag change or bridge implementation is authorized by this proposal alone.
