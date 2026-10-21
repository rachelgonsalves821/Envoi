# Muse and Instinct Phase B route closeout packet

Prepared 2026-10-21 by Rachel/Codex from locally cached `origin/integration/agent-native` at `454ab2261a29f90838fba7c4f207e62f1aeb94d9`. The remote fetch was unavailable while preparing this packet; rebase and recheck GitHub before a PR or live gate. **Both hosts remain OPEN.** This packet assigns work to Rachel/Codex and records the next observable proof. It neither enrolls an agent nor approves a provider route.

## Current implementation and route decision

The integrated [provider browser gateway](../../provider-gateway/IMPLEMENTATION.md) has a default-off `provider-browser-poll v1` Stage 1: installation-scoped browser pairing, private server-side credentials, bounded read/notify checks, durable cursors, renewal and lifecycle controls. Local HTTP, FileStore and PostgreSQL tests cover this server boundary. It has no Stage 2 canonical claim/send/reply/settlement and no actual Muse or Instinct session or schedule proof. Its gateway acknowledgement means a notification was shown, not that the agent completed work.

Evaluate routes in this order for each **exact product, build, account plan and region**:

| Host | First supported path to inspect | Fallback to inspect | Current conclusion |
| --- | --- | --- | --- |
| Muse | User-created Custom Connector and its Secure Credentials Store, followed by actual read/write and scheduling behavior | Reviewed/listed Connector Platform route; private browser gateway if an account-visible host task can keep its own delegated session | Public documentation establishes candidates only; no Envoi tool call or closed-app reply is evidenced. |
| Instinct | Account-visible custom connector, MCP, trusted REST or delegated browser session plus supported recurring task | Separate constrained email feasibility, only after the native investigation | Public site describes phone/computer operation; it does not document a secure Envoi connector or incoming wake contract. |

Meta states that a user can ask Muse to create a [Custom Connector](https://www.meta.com/help/superintelligence/1687253048996149/) and that credentials go in its Secure Credentials Store. Meta says it does **not** review these user-created connectors. A listed [Connector Platform](https://platform.muse.ai/docs) submission is separate: Meta reviews tool permissions and requires approval each time for a sensitive write. Meta describes [general background work](https://ai.meta.com/muse/) after app closure, which does not prove Envoi task scheduling or unattended send/reply. The [Instinct public site](https://instinct.com/) gives no developer contract for the necessary private auth or wake path. No public claim substitutes for an actual account observation.

### Muse account observation, 2026-10-21 21:21 UTC

With Rachel's signed-in Muse web account open in Chrome, Codex inspected Settings → Connectors. The account has a **Connected** tab with existing connectors, and an inspected connector exposes a per-connector **Background sync** control set to **Allow**. The account also exposes a Goals view. This proves those controls are visible in this account; it does not establish that Envoi is connected, that Muse has a supported Envoi arrival trigger, or that it can claim/send/reply while the app is closed. No connector, credential, goal, schedule, or permission was created or changed during this observation. The next Muse test is an Envoi-specific custom connector on a pinned hosted release with approved OAuth and action contracts, followed by the two-item closed-app gate below.

## Work Rachel/Codex can drive

1. **Account capability capture.** Rachel opens each actual host account; Codex records a redacted screenshot or provider documentation reference, product/build, plan/region, available connector setup, private credential store or delegated browser behavior, native schedule/task creation and readback, approval prompts and provider restrictions. No operational secret is pasted into chat or evidence. A visible field or provider answer is labeled `interface observed`; only a real Envoi call can be labeled `route exercised`.
2. **Route authorization and contract.** For Muse Custom Connector, record the account's owner consent and actual allowed tools; for a listed connector, record submission/review ID and approved tool classifications. For Instinct, record a supported interface or the provider's exact blocker. Rachel decides the selected route and scope. Codex prepares client/setup and fixture-consumption work. Any canonical server change or Stage 2 write contract is reviewed against existing ownership boundaries and requires the exact approved contract before implementation.
3. **Actual exchange.** On a frozen hosted Envoi SHA, record registration/claim/installation IDs in restricted evidence, private credential custody, authenticated identity and inbox result IDs, an approved send and reply with canonical receipts, renewal after uncertain response, same-identity reconnect, pause/resume and revoke. A read/notify gateway pass is not an exchange pass.
4. **Closed-app wake.** On that same release, close the host, inject two separately timed owner-approved synthetic items in different cases, observe actual host invocation, authenticated fetch, action approval, canonical reply and one logical effect per item. Then run missed notification, restart, duplicate, pause/held/resume, revoke and late action cases. Record every reopening or prompt. `notification shown`, `host woke`, and `unattended reply` are separate results.
5. **Truthful availability.** Publish only modes actually offered by the server and proved on that exact host. A working open-chat exchange with no closed-app invocation is an on-demand candidate only after its contract and owner label are approved. Otherwise leave the host unavailable in `/connect`.

## Actual-account observation card

Make one copy per host and route. All values begin `NOT SUPPLIED`, `UNTESTED` or `BLOCKED`; never prefill `PASS`.

| Field | Observation/evidence |
| --- | --- |
| Product/build, plan, region and account-visible setup path | NOT SUPPLIED |
| Route, provider approval or Custom Connector basis, allowed tool scope | NOT SUPPLIED |
| Private credential custody or delegated browser session persistence | UNTESTED |
| Native scheduled/incoming trigger, task readback, cadence and limits | UNTESTED |
| Hosted Envoi SHA, staging URL, artifact hashes and approved contract | NOT SUPPLIED |
| Identity/inbox/send/reply request and canonical receipt IDs | UNTESTED |
| Per-use approval prompts, including changed recipient/content/scope | UNTESTED |
| Closed-app item 1 and 2: sent, invoked, fetched, replied, effect count | UNTESTED |
| Missed tick/channel loss, restart, renewal, reconnect, pause and revoke | UNTESTED |
| Owner countersign or explicit scope-change reference | NOT SUPPLIED |

Redact addresses, case text, cookies, credentials and raw private mail from repository evidence. A transport delivery receipt proves transport only. Each row needs timestamps, redacted request/case IDs, the exact host and Envoi release, and an evidence link. Use [BREADTH-EVIDENCE.md](BREADTH-EVIDENCE.md) for the consolidated Phase B gate.

## Conditional Instinct email decision

Email is **not** the accepted installation route and is not the default fallback from a missing custom connector. First establish whether the actual Instinct account has an assistant-owned mailbox, whether the provider permits machine-correlated automated replies, and whether a private native interface or the delegated browser route works. A provider-approved mailbox can deliver a notice but cannot by itself establish Instinct execution or authorization to write into an Envoi case.

If email is the only supported path, Rachel may commission a **separate** scoped contract with these decisions before code: verified assistant mailbox and owner binding; authenticated mail-provider ingress and authoritative sender provenance; one active server-side correlation per installation/case/work/generation; minimum content disclosure; no bearer or bootstrap secret in mail; one canonical reply effect across retries and Message-ID changes; current permission/lease/fence checks at the effect boundary; quarantine of ambiguity, forwards, bounces and late replies; explicit retention and deletion; pause/revoke behavior for mail already sent. An opaque notice plus authenticated native fetch is preferable if the provider supports it. A content-bearing bridge needs explicit disclosure and cannot be called native tool access. The detailed earlier [proposal in PR #137](https://github.com/rachelgonsalves821/Envoi/pull/137) is a review input, not an approved contract or working route.

## Ownership and exit

Rachel owns provider account observations, selected scope, any provider submission and the eventual beta decision. Codex owns this capability matrix, setup/client implementation within its assigned paths, offline verification and the host evidence record. Je may review a shared canonical server boundary but is not the default lead of this track. No provider submission, account change, scheduler creation, email, staging flag or live test was made while preparing this packet.

The investigation subtask closes when each exact host has an evidenced supported route **or** a precise provider restriction with a next request. Full Phase B host acceptance remains open until a real identity/inbox/send/reply exchange and the separately reported closed-app/lifecycle gate pass, or Rachel explicitly changes the named-host scope. A limited beta for other proven hosts does not silently close Muse or Instinct.
