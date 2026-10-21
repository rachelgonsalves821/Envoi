# Muse and Instinct Phase B route closeout packet

Prepared 2026-10-21 by Rachel/Codex from locally cached `origin/integration/agent-native` at `454ab2261a29f90838fba7c4f207e62f1aeb94d9`. The remote fetch was unavailable while preparing this packet; rebase and recheck GitHub before a PR or live gate. **Both hosts remain OPEN.** This packet assigns work to Rachel/Codex and records the next observable proof. It neither enrolls an agent nor approves a provider route.

## Current implementation and route decision

The integrated [provider browser gateway](../../provider-gateway/IMPLEMENTATION.md) has a default-off `provider-browser-poll v1` Stage 1: installation-scoped browser pairing, private server-side credentials, bounded read/notify checks, durable cursors, renewal and lifecycle controls. Local HTTP, FileStore and PostgreSQL tests cover this server boundary. It has no Stage 2 canonical claim/send/reply/settlement and no actual Muse or Instinct session or schedule proof. Its gateway acknowledgement means a notification was shown, not that the agent completed work.

Evaluate routes in this order for each **exact product, build, account plan and region**:

| Host | First supported path to inspect | Fallback to inspect | Current conclusion |
| --- | --- | --- | --- |
| Muse | Reviewed/listed Connector Platform route with Meta approval, followed by actual read/write and scheduling behavior | None selected for this beta; a user-created Custom Connector remains outside Rachel's chosen scope | No Envoi-origin response, canonical exchange or closed-app reply is evidenced. |
| Instinct | Account-reported delegated browser or per-item-approved private API script plus scheduled task | No selected fallback | Instinct's assistant reports that it cannot install third-party MCP servers. A native Envoi installation, work exchange and wake still need a live test and owner approval. |

Meta states that a user can ask Muse to create a [Custom Connector](https://www.meta.com/help/superintelligence/1687253048996149/) and that credentials go in its Secure Credentials Store. Meta says it does **not** review these user-created connectors. A listed [Connector Platform](https://platform.muse.ai/docs) submission is separate: Meta reviews tool permissions and requires approval each time for a sensitive write. Meta describes [general background work](https://ai.meta.com/muse/) after app closure, which does not prove Envoi task scheduling or unattended send/reply. The [Instinct public site](https://instinct.com/) gives no developer contract for the necessary private auth or wake path. No public claim substitutes for an actual account observation.

**Beta route decision, 2026-10-21:** Rachel excluded the user-created Custom Connector path from the beta. The selected Muse path is a reviewed/listed Connector Platform submission and therefore needs Meta's approval. This is a product scope decision; Meta's separate user-created path does not acquire a review requirement by implication. Keep Muse unavailable until the reviewed route, private authorization, canonical exchange and closed-app evidence pass.

### Muse account observation, 2026-10-21 21:21 UTC

With Rachel's signed-in Muse web account open in Chrome, Codex inspected Settings → Connectors. The account has a **Connected** tab with existing connectors, and an inspected connector exposes a per-connector **Background sync** control set to **Allow**. The account also exposes a Goals view. This proves those controls are visible in this account; it does not establish that Envoi is connected, that Muse has a supported Envoi arrival trigger, or that it can claim/send/reply while the app is closed. No connector, credential, goal, schedule, or permission was created or changed during this observation. The next Muse step is to prepare and submit the reviewed Envoi connector for Meta approval, then test its approved auth/tool surface on a pinned release before the two-item closed-app gate below.

### Historical Muse Custom Connector probe, observed 2026-10-21

Rachel's signed-in Muse chat shows an earlier, now excluded `custom.envoi-staging` read probe. Muse reported a securely stored short-lived credential and two authorized read requests. It reported Cloudflare edge `1010` / `browser_signature_banned` on the first attempt, then its own `sentinel-policy` egress denial on a later attempt. Neither report included an Envoi-origin identity or availability response. Muse's assistant was told to stop and not retry those denied calls. This account history records a failed Custom Connector probe and a concrete reported provider/network-policy blocker for that path; it does not satisfy the selected reviewed Connector Platform route, and no credential or raw account transcript is reproduced here.

### Instinct account observation, 2026-10-21 21:25 UTC

Rachel's Instinct contact is a WhatsApp business account whose profile links to the signed-in `app.instinct.co` portal. Its Workspace lists Messages and WhatsApp. The visible connector catalog offers named services, including Google Workspace, Outlook, Linear, Notion, GitHub, Slack and Granola; no custom API, MCP or generic webhook setup was exposed in that Workspace view. This is **interface observation**, not proof that Instinct lacks another supported route. No connector, credential, task or permission was changed during this observation. The relevant question is how Instinct becomes an authorized Envoi installation that uses native Envoi work and case APIs.

### Instinct assistant reply relayed by Rachel, 2026-10-21 21:34–21:35 UTC

Rachel sent the setup-only question to Instinct in WhatsApp and relayed its reply. This is an **assistant-reported capability claim**, not provider documentation, an approved Envoi route, or a live test. The reply says:

- A delegated browser login can be stored through an Instinct private link; a human approves the first sign-in and any Duo/SMS challenge. A private API credential can be used by a script after approval of the specific item, subject to the API's auth requirements.
- Instinct cannot install or connect third-party MCP servers. Remove third-party MCP installation from the Instinct candidate route unless a provider-published capability changes.
- The assistant reports scheduled tasks and event triggers while the chat is closed. It says a WhatsApp follow-up after 24 hours uses a short reply-request template. No Envoi task, run log, or closed-app execution was observed.
- No service, login, credential, schedule, standing authorization, or Envoi route was connected in this exchange.

Rachel clarified the product route: Instinct must participate in Envoi as an authorized agent installation, not through the user's email. No mailbox probe is selected, and no test email should be sent. The next bounded investigation is the actual Instinct-to-Envoi path on the exact account: establish whether a scheduled Instinct task can use a privately saved Envoi API credential or delegated browser session, call a pinned staging release for authenticated identity and a synthetic inbox item, and report the task's own invocation and approval record while the chat is closed. A subsequent, separately approved test must perform the canonical case reply and confirm one Envoi effect. Record whether every item requires a human approval; if it does, do not claim unattended replies.

### Instinct follow-up relayed by Rachel, 2026-10-21 21:42 UTC

Instinct's assistant says recurring scripts **should** make HTTPS GET/POST requests with an idempotency header, but it has not tried a live API and proposes a harmless GET first. It says Rachel would save a credential through a private link, approve the particular script's use, and the script would use a private temporary file without printing the credential. The exact custody, renewal, deletion and revoke behavior have not been observed. It reports no run-log dashboard: on request it can provide its own saved time/request/result/key summary. That is a host report, not independently verified execution evidence.

### Bounded public staging probe relayed by Rachel, 2026-10-21 22:30–22:39 UTC

Instinct reported creating exactly two one-time, unauthenticated `GET /ready` schedules, `wakeschedule-01M5G9C356XW9YMNPPZGR420WF` for 18:34 ET and `wakeschedule-01M5G9C3B8ED7DBP0XBPB4W80M` for 18:39 ET. Rachel relayed the reported executions: run 1 at 18:34:58 ET and run 2 at 18:39:36 ET, each HTTP 200 with `ready: true` and `releaseSha: 2b18170d59b0096ff997d9a79487d50ccb627ef9`. Instinct said both single-fire schedules were consumed and no test schedule remains. This is provider-reported scheduled HTTPS execution against a public endpoint. Whether the WhatsApp chat was closed at both execution times is awaiting Rachel's confirmation; no server request log was inspected. The probe did not establish Envoi authorization, installation identity, work claim, case session, reply, or unattended write approval. No credential or case data was sent.

It expressly says **no persistent SSE connection**: background work runs on schedules or event wakes, with polling every few minutes as the closest equivalent. It also says Rachel can grant standing permission in her own words, scoped to Envoi recipients, allowed actions/content, limits and an end date; actions outside the grant return for approval. Credential/task binding, schedule and grant can reportedly be revoked. These are provider-assistant claims, not Envoi authorization, a created task, or a tested reply. Nothing is connected.

**Confirmed compatibility gap from the reported host mechanism:** the current `authenticated_rest` registration helper accepts only a trusted persistent process with HTTPS and SSE; it explicitly rejects `scheduledPolling`. The provider browser gateway's Stage 1 permits bounded read/notify checks but not canonical claim or reply. A scheduled Instinct task therefore cannot enroll through the current generic REST client. Lane A must publish and obtain approval for a compatible scheduled native delivery/action contract, or the Stage 2 gateway must meet the canonical work boundary, before this host can pass the native acceptance test. Do not hand Instinct the current portable REST host CLI as if it fit that runtime. A host-stated standing grant cannot replace Envoi's owner-approved, current-policy and exact-action checks.

## Work Rachel/Codex can drive

1. **Account capability capture.** Rachel opens each actual host account; Codex records a redacted screenshot or provider documentation reference, product/build, plan/region, available connector setup, private credential store or delegated browser behavior, native schedule/task creation and readback, approval prompts and provider restrictions. No operational secret is pasted into chat or evidence. A visible field or provider answer is labeled `interface observed`; only a real Envoi call can be labeled `route exercised`.
2. **Route authorization and contract.** For the selected listed Muse connector, record submission/review ID, approved tool classifications, account owner consent and allowed tools. For Instinct, record a supported interface or the provider's exact blocker. Rachel decides the selected route and scope. Codex prepares client/setup and fixture-consumption work. Any canonical server change or Stage 2 write contract is reviewed against existing ownership boundaries and requires the exact approved contract before implementation.
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

## Ownership and exit

Rachel owns provider account observations, selected scope, any provider submission and the eventual beta decision. Codex owns this capability matrix, setup/client implementation within its assigned paths, offline verification and the host evidence record. Je may review a shared canonical server boundary but is not the default lead of this track. No provider submission, account change, scheduler creation, email, staging flag or live test was made while preparing this packet.

The investigation subtask closes when each exact host has an evidenced supported route **or** a precise provider restriction with a next request. Full Phase B host acceptance remains open until a real identity/inbox/send/reply exchange and the separately reported closed-app/lifecycle gate pass, or Rachel explicitly changes the named-host scope. A limited beta for other proven hosts does not silently close Muse or Instinct.
