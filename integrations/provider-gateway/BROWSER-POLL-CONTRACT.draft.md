# Installation-scoped browser session and scheduled polling — contract draft

Proposed contract ID: `provider-browser-poll`, version `1`, draft revision `1` (2026-10-18). Base: integration `c334db199f44f0ce1a3d83d2fef078a3d99ff37c`. **PROPOSED ONLY: not CONTRACT-PUBLISHED, ACKed, approved, implemented, deployed or host-tested.** Paths, names and limits below are exact proposals for review, not descriptions of available endpoints. Both Muse and Instinct remain OPEN.

Authority: existing [registration, auth, presence and work contracts](../../docs/architecture/agent-native-v2/handoffs.md); [gateway architecture](ARCHITECTURE.md). This draft does not amend canonical contracts in place. Lane A publishes accepted text and executable fixtures; Codex consumes/reviews them; Rachel approves the exact published version before dependent implementation.

## 1. Scope and route decision

Stage 1 implements an installation-scoped browser gateway and read/notify polling. No SMTP bridge, public inbox, owner-dashboard impersonation, new identity store, new conversation protocol, file download, arbitrary URL fetch, or generic privileged proxy. Browser-session users cannot use ordinary agent bearer endpoints with the browser cookie. The gateway is the trusted credential-owning client of canonical services.

Proposed registration declaration: `connectionRoute: authenticated_rest`, `deliveryMode: poll`; the trusted server-side gateway is the REST client and `runtime.type` describes the actual host as untrusted metadata. No `browser` route enum. Enable only after the route/mode amendment and route gate. Private custom API clients are another candidate, not browser-session emulation: use them only after the actual auth/header/secret-isolation mechanism is proved and its authorization contract approved. Do not categorically exclude any named host from that candidate. Public-source and private-account observations remain distinct; account transcripts stay outside public Git.

Required new default-off flag, proposed name `ENVOI_PROVIDER_BROWSER_POLL`, depends on both existing V2 registration/installation flags and the authenticated REST route. This flag enables only the reviewed browser gateway + poll combination, not arbitrary `poll` activation by every existing REST client. Existing v1 clients retain their current route response/schema. Lane A must publish a versioned capability extension identifying the permitted route/mode pair and gateway-mediated activation; flat `available:true` is insufficient to authorize every combination. Off means new gateway routes return `404 FEATURE_DISABLED`, no new pairing, checks or activation; existing delegated sessions are suspended rather than given a legacy fallback. Recovery after reenable requires current authorization and unexpired session state, not reenrollment.

Proposed capability discovery is `GET /api/onboarding/routes?contract=provider-browser-poll-v1`, with a separate closed response `{contract:{id:"provider-browser-poll",version:1}, gatewayAvailable:boolean, allowedPairs:[{connectionRoute:"authenticated_rest",deliveryMode:"poll",activationAuthority:"gateway"}]}`. `allowedPairs` is empty unless all dependencies are enabled; this discovery response remains `200` with `gatewayAvailable:false` when the rollout flag is off. Cache publicly for at most 60 seconds, with no identity or evidence claims; mutation/read authorization always rechecks live server state. The unversioned URL retains the exact v1 schema. Missing or forged client assertions cannot supply `activationAuthority`: that is an internal server property of the trusted gateway call, never accepted as a registration/activation body field. Unknown requested contract versions return a safe unsupported-version error, not a fallback to enabled v1 semantics. Je may replace this versioning mechanism explicitly during publication, preserving the compatibility and pair restrictions.

## 2. Principals and authority

- **Owner control plane:** existing admitted, authenticated human, current workspace membership/management permission and required assurance, CSRF and owner confirmation. An owner cookie is never a gateway-runtime credential. The agent must not operate the owner's signed-in dashboard to approve itself.
- **Pending browser:** opaque pending-session cookie bound to exactly one pending registration. Can read its safe pairing status only. No identity/inbox/work/asset rights, no bearer/bootstrap token returned to the browser or model.
- **Delegated browser:** opaque session bound server-side to one `{ownerId, workspaceId, agentId, installationId, credentialFamilyId, generation}` plus a permission ceiling. IDs are server state, not accepted from runtime requests. Current canonical permission and lifecycle checks still apply. Stored scope never widens a later reduced grant.
- **Gateway service:** holds encrypted server-side installation credentials, owns renewal/rotation/recovery and invokes canonical services under that installation. It has no ambient cross-installation authorization and no model-controlled proxy destination or auth headers.
- **Host scheduler:** invokes the real host browser/client. Its metadata and reports are claims, not proof of closed-app execution or user receipt. No schedule is created inside this Codex chat by this draft.

For Stage 1 the effective delegated scope is only identity/status and bounded pending-work notification projection. No native send, claim, renewal-of-work-lease, settlement, human decision, permission change, asset creation/download or owner-management operation is reachable through this session. Private grant renewal is server-internal and is not work-lease renewal. Stage 2 actions are described in §9 but remain disabled until separately reviewed.

## 3. Proposed limits and formats

| Item | Proposed rule |
| --- | --- |
| Session secrets | At least 256 CSPRNG bits; only keyed digests stored for lookup; separate pending and operational cookie namespaces |
| Pending pairing | 10 minutes maximum, never extended by polling; one active pending request per browser, at most three per admitted owner once bound; preserve canonical anonymous registration creation/network quotas |
| Pairing operation ID | Server-issued 128-bit random reference, persisted before registration creation/activation; retries reuse the same server operation; never treated as authorization |
| Operational browser session | 7-day absolute lifetime and 24-hour inactivity limit, checked server-side; scheduling cannot extend absolute expiry; timestamps use server UTC |
| Browser cookie | `__Host-envoi_agent_gateway`; `Secure; HttpOnly; SameSite=Strict; Path=/`; no Domain; Max-Age never exceeds remaining absolute lifetime; pending cookie `__Host-envoi_agent_pair` with same protections and 600-second maximum |
| CSRF | Synchronizer token bound to current pending/operational session and generation; supplied in same-origin POST header or hidden form field, never URL; not an operational bearer grant |
| Schedule | Default cadence 1,800 s; supported 300–86,400 s; owner approves cadence and alert destination; change requires owner control-plane action; no faster implicit retry loop |
| Poll budget | One active run per installation; maximum 120 s and five pages per run; page limit default 20, maximum 50; minimum 60 s between new checks per installation; continuation of one run is exempt |
| Payload | JSON request maximum 8 KiB; response maximum 64 KiB UTF-8 including escaping; per-item summary maximum 2 KiB and display names maximum 80 characters; omit/truncate on code-point boundaries and set `truncated:true` |
| Read refs/cursors | Opaque authenticated-encrypted values, maximum 512 characters, expire 24 h after issue; bind installation, generation, projection version and snapshot; not bearer capabilities |
| Check run | Client/server-issued nonsecret `runId`, maximum 80 safe ASCII characters, bound to session; one run cannot change cadence, grant or identity |
| Transport retry | At most two retries per run, respect Retry-After, 5–30 s jitter; if server delay exceeds remaining run budget, end run and leave work pending for next tick |
| Notification dedupe | Stable per-installation notification key per canonical work/version; replacement session/cursor does not reset it; retain while work is actionable and 30 days after terminal status; no case body copied into ledger |
| Status freshness | Grace = max(120 s, min(600 s, ceil(cadenceSeconds / 5))); overdue only when server `asOf > lastSuccessfulCheckAt + cadence + grace` |

Seven-day reauthorization is an explicit proposed tradeoff, not indefinite availability. At expiry show `needs_reconnect`; the owner re-pairs the existing installation after current-policy checks. No saved owner password, host standing allow, cookie filling or recurring task waives owner MFA/assurance requirements.

For clarity, re-pairing a browser session may reuse only an active, eligible installation and its current credential family after owner reauthorization. If that installation/family ended, use canonical owner-approved attachment to the same agent identity, with a new installation if required by the existing contract. Never revive an ended family/installation or falsely promise that reconnect always preserves the installation ID. Browser possession is possession of a scoped credential, not hardware attestation or proof of a particular host brand.

## 4. Browser pairing and activation

All URLs use one configured canonical HTTPS Envoi origin. No dynamic host/redirect URL is accepted. Proposed clean pages: `/agent-gateway/connect` (pair), `/agent-gateway/inbox` (delegated runtime), and the existing `/claim` (owner claim). Query strings never contain verification codes, secrets or operational tokens. Cross-site initial navigation may show a generic page because Strict cookies are absent; it must not create an additional registration. The user/host follows a same-origin form action to continue.

1. `GET /agent-gateway/connect` returns a no-store, content-free setup shell and a short-lived pending-session/CSRF context. It does not register, approve, activate or fetch work. An existing pending or active gateway cookie is recognized without creating another registration.
2. Same-origin `POST /api/agent-gateway/pairings` takes a closed object `{requestedName, requestedPermissions, runtime}` plus CSRF. Stage 1 accepts only `receive_agent_messages`. The gateway fixes the route to `authenticated_rest` and requested mode to `poll` under this proposed amendment; clients cannot choose a workspace, owner, installation or arbitrary route. It invokes the existing registration service and stores bootstrap/activation material server-side. Return `201` with only `{state:"pending_claim", claimUrl, verificationCode, expiresAt, retryAfterSeconds:5}`. Repeated requests for the same live pending session reuse its registration/result; no parallel anonymous registration on refresh or uncertain response. Canonical registration is not itself made idempotent by this wrapper. The server persists one operation intent and reconciles ambiguous outcomes; it may not blindly repeat non-idempotent creation after a crash. If reconciliation is impossible, mark recovery required and wait for the orphan to expire or owner intervention.
3. The person uses their own existing authenticated owner session at the clean claim page and types the code. Apply canonical owner membership, assurance, permission, target/reconnection, stale-request and limits unchanged. Extend the owner summary to explicitly approve a browser delegation, read/notify scope, cadence, destination and absolute session lifetime. A code or model statement alone is not approval. Show a nonsecret random comparison phrase in both pending browser and owner confirmation; require the person to compare/confirm the intended runtime. The delegated browser cannot invoke this owner approval with its cookie.
4. `GET /api/agent-gateway/pairing` returns only safe state, masked verified approver, workspace/agent display values, approved permission summary, comparison phrase and deadlines. Unknown/pending-cookie mismatch returns the same `401 GATEWAY_SESSION_REQUIRED`. Approved state grants no work access. State is time-derived even if cleanup has not run. Polling may not extend approval or pairing expiry.
5. Same-origin `POST /api/agent-gateway/pairing/activate` takes closed `{operationId}` plus pending-cookie CSRF. Require the recorded attributable owner confirmation for the intended registration and current canonical approval/membership. Activate once through the existing installation service using persisted activation identity; no new credential family on retry. Persist credential result and activation completion before returning. Replace pending cookie with a new operational session secret; clear pending cookie. No access/refresh/bootstrap secret appears in response, HTML or DOM. Return `200` safe `{state:"connected", agentAddress, permissionSummary, expiresAt}` only after the canonical authenticated status check succeeds. If credentials cannot be recovered, return `recovery_required`, never falsely connected or silently reenroll.
6. A lost final response retries with the same pending operation during its bounded activation-recovery window. The server durably retains a recoverable encrypted cookie secret for this operation, bound to the original pending browser, for at most the existing 300-second canonical activation-recovery window; it may repeat Set-Cookie for that same session, not mint a second installation. It otherwise stores session digests only. If that window expires, refuse the pending cookie and require owner-authorized repair of the existing installation. A replay after successful credential rotation/revoke cannot revive the old binding. The encrypted recovery secret is a deliberate exception Je must review, redact and delete on recovery-window expiry.

The pending browser cookie is a setup credential but is never exposed to the model; the verification code/comparison phrase are pairing information, never operational read/write authority. Do not auto-login the owner's dashboard, email a key or ask the assistant to extract credentials from its vault.

## 5. Session isolation, renewal and security envelope

Gateway requests authenticate **only** the dedicated session cookie; no ordinary owner-cookie fallback, raw installation ID, body-supplied owner/agent ID or query bearer. Owner endpoints accept only their established human auth and never the delegated cookie as human authority. Every operation checks installation generation, active family, current membership/authorization and effective permission, including lifecycle races under the existing canonical transaction locks. Expired/revoked sessions cannot be renewed by model-driven retries.

Read-only requests may record successful presence, not change case/work/notification-ack state. Pairing activation, schedule metadata, sign-out, renewal, checks and acknowledgements are POST with exact-origin validation and synchronizer CSRF; reject cross-site or absent/mismatched Origin, `Sec-Fetch-Site: cross-site`, unsupported content type and duplicate auth headers. Same-origin HTML forms may carry the CSRF field because browser-only hosts cannot be assumed to construct custom headers. Strict SameSite is defense in depth, not the only CSRF defense. API clients using separately approved bearer auth cannot reuse the browser CSRF exception.

Proposed POST encodings: `application/json` with CSRF in `X-Envoi-Gateway-CSRF`, or `application/x-www-form-urlencoded` containing exactly `payload` (one JSON-encoded closed request object) and `csrf` (the synchronizer token). Reject duplicate form keys, invalid JSON/encoding, extra fields, multipart bodies and either representation exceeding the 8 KiB wire limit. Both encodings run the same request validator and authority checks; no browser form bypass. Successful `check` or `session/renew` may advance idle activity within the absolute lifetime; merely opening a shell/status page or a failed request cannot keep a delegation alive.

`POST /api/agent-gateway/session/renew` takes `{}` plus current-cookie CSRF; returns safe expiry only. It may extend idle expiry within the unchanged absolute lifetime. It refreshes canonical installation credentials privately with one persisted rotation operation and canonical lost-response recovery. At absolute session expiry, missing membership, reduced-away scope, invalid family, pause restriction or uncertain terminal auth, it refuses instead of creating a new installation. Session secret rotation on relinking or privilege change invalidates prior generation/CSRF. Routine concurrent polling does not rotate the cookie, avoiding lost Set-Cookie races. Reauthentication/relink uses owner approval and canonical same-identity attachment, not privileged fallback.

All gateway HTML/JSON including errors: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame denial, no credentialed cross-origin access, no third-party scripts/analytics/service-worker caching. A strict CSP permits only required same-origin assets, forbids framing, inline untrusted scripts and off-origin form submissions. Render case content as escaped untrusted text; no remote images, links auto-fetching or executable HTML. Request logging redacts cookies, CSRF, pairing code, comparison phrase, body and operational material. Audit actor is the delegated installation/session, never human solely because a browser clicked.

Session hardening references, checked 2026-10-18: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html). Values and flows above are Envoi proposals, not prescribed defaults from those references. HttpOnly prevents script reads but does not make the cookie harmless or protect against a malicious authorized browser runtime.

## 6. Polling and notification projection

### 6.1 Endpoints and response

`GET /agent-gateway/inbox` and `GET /api/agent-gateway/session` return the safe identity/session shell (or appropriate no-store error), without claiming work or acknowledging notifications. The HTML page includes same-origin POST forms and bounded accessible text so a browser-only assistant can operate it without extracting a token or writing raw HTTP.

`POST /api/agent-gateway/check` takes one of closed `{runId, limit?}` or `{runId, cursor, limit?}`, authenticated by session + CSRF. No caller-supplied agent/case identity. First-page creation serializes a run per installation with a durable expiring guard; same run replay is allowed, a different overlapping run returns `409 GATEWAY_CHECK_ACTIVE`. After the 120-second guard expires, a new run can resume unacknowledged canonical work. An old run cannot advance the newer run's acknowledgement checkpoint.

Proposed `200` response shape (safe fictional values):

```json
{
  "contract": {"id":"provider-browser-poll","version":1},
  "state":"active",
  "asOf":"2026-10-18T22:00:00Z",
  "runId":"run_example",
  "agentAddress":"agent@agents.envoi-agents.com",
  "items":[{
    "notificationRef":"n_example",
    "caseRef":"c_example",
    "workVersion":1,
    "senderAddress":"peer@agents.envoi-agents.com",
    "summary":"A peer requested a status update.",
    "truncated":false
  }],
  "nextCursor":null,
  "retryAfterSeconds":1800
}
```

JSON rejects unknown request fields. Runtime/model-visible IDs are scoped opaque notification/case references, not credential family, internal owner/workspace/storage or lease identifiers. Resolving a ref always requires the current session and authority. Output uses the existing sanitized display-name/token-redaction rules. Summary cannot include ungranted/unscanned asset content or instructions to bypass approval. No download/file URL or raw canonical snapshot escapes the Stage 1 allowlist.

### 6.2 Selection, cursor and checkpoint semantics

"New work" means canonical pending actionable inbound work for **this installation's agent**, not yet notification-acknowledged for this installation and canonical work version. Include required owner-attention items only if their existing policy permits this agent to know the bounded fact; never expose another workspace's owner-private question/decision record. Held work is not actionable while paused. Terminal/cancelled/unauthorized work is excluded at read time. A notification ledger stores refs, canonical keys/version and acknowledgement status, not duplicate messages or an inbox source of truth.

Order by a canonical server-assigned enqueue sequence, tie-broken by canonical ID; do not use producer-supplied/backdated timestamps as a checkpoint. Snapshot cursor carries an immutable high-water sequence plus last-read key and session generation. New arrivals after the high-water appear in the next run. The projection must use an existing canonical monotonic sequence or a transactionally maintained rebuildable index; Je must select and prove that mapping in publication. No independently populated queue may become authoritative. If the baseline cannot supply a sequence safely, publication must amend this algorithm explicitly before implementation.

Cursor is pagination only, **never notification acknowledgement or work settlement**. Recheck permissions/lifecycle for every page; a snapshot cannot preserve access after revoke/pause. Expired/invalid/other-installation cursors return `400 GATEWAY_CURSOR_INVALID`; restart from current canonical pending work and the existing notification ledger, never from an arbitrary "now" that loses work. Deliver at most the per-run budget; remaining work stays eligible next run. Two pages/retries may repeat unacknowledged refs. A replacement schedule or session reuses the installation's ledger; a new installation has its own notification progress but shares canonical work authority.

`POST /api/agent-gateway/notifications/ack` takes closed `{runId, notificationRefs:[...]}`; 1–50 unique refs from pages actually issued to that run. It records only **the host's assertion of presentation**, never proof the owner saw an alert, canonical work acknowledgement, processing or approval. Validate every ref/current scope before atomically recording the batch; reject mixed invalid/wrong-tenant refs with no partial commit. Retry the same logical batch returns the same outcome. Acknowledged refs do not reappear for that installation/version; conflicting or changed work version is a new notification. Rendering/checking alone never calls this endpoint automatically.

The host sends its configured owner alert first and records notification ack only after its supported alert interface confirms acceptance. If confirmation is unavailable or a crash loses that result, leave refs unacknowledged: notification delivery is at least once, with possible duplicates explicitly disclosed. No promise of exactly-once user notification. Underlying work remains pending until independently acted on through canonical services, even when notification ack succeeds.

## 7. Schedule metadata and presence amendment

Proposed owner-authenticated `POST /api/inboxes/{inboxId}/agents/{agentId}/installations/{installationId}/poll-policy` takes closed `{cadenceSeconds, alertDestination:"host_owner", expectedPolicyRevision}` plus existing owner CSRF/assurance. Canonical owner-management authorization applies. It updates only approved policy metadata; neither creates nor proves a provider task. Scope to the existing owner; no third-party email/SMS/webhook destination.

The host scheduler adapter must create/read back one real task under owner-approved setup using the actual supported host interface. Reuse its task on uncertain setup, record private task reference/lifetime separately, and never put credentials or private callback URLs in prompts/metadata. Task metadata reported through the gateway is untrusted and cannot enable routes or set `closedAppVerified`. Missing/expired task yields visible recovery; no reenrollment or silent auto-recreation. Initial 30-minute cadence is a proposal for both hosts, not a claim about their minimum supported interval.

Add a versioned polling projection, not a silent rewrite of a5-presence v1: `{cadenceSeconds, graceSeconds, lastSuccessfulCheckAt, expectedNextCheckAt, scheduleReportedState, checkState, closedAppEvidenceState}`. Existing clients keep their fields and semantics. `lastSuccessfulCheckAt` advances only after a fully authorized first check page succeeds; request arrival, status shell, schedule report and failed auth do not advance it. This is a gateway-check timestamp, **not** claim, model invocation, processed receipt or alert success. Boundaries use server `asOf`; negative ages clamp to zero. Null last-check means `not_yet_checked` with null expected-next; otherwise expected-next = last-success + cadence. At exactly expected-next + grace, still `scheduled`; only greater is `overdue`. No claim of continuous online presence.

Precedence: ended/revoked installation → `revoked`; expired/missing delegation or canonical auth/membership failure → `needs_reconnect`; rollout disabled → `unavailable`; paused agent → `paused`; task explicitly reported missing/expired → `schedule_needs_attention`; no successful check → `not_yet_checked`; past deadline → `overdue`; otherwise `scheduled`. `scheduleReportedState` is a host report with a timestamp, never an independent accepted observation. Closed-app evidence is `unverified` until a separately countersigned exact-host/release record is linked by the authorized evidence process; the model cannot post a pass.

## 8. Lifecycle and errors

Pause keeps only allowed status/auth checks; `check`, page-content and notification-ack endpoints return `409 AGENT_PAUSED` with no work contents or acknowledgement mutation. Preserve canonical held ordering and notification progress. Revoke/ended family invalidates session and pending operation generation before subsequent reads/effects, rejects late ack/actions and clears cookie on response; orphaned provider tasks do not retain access. Explicit owner resume requires no new identity but rechecks delegation. Reconnect or new browser profile requires owner-authorized pairing for the same eligible installation/identity under canonical attachment rules; never restore a revoked family or reset absolute expiry without consent.

| HTTP / code | Runtime behavior / side effects |
| --- | --- |
| 404 `FEATURE_DISABLED` | Route/mode unavailable; stop; no fallback or enrollment |
| 401 `GATEWAY_SESSION_REQUIRED` | Missing/unknown pending or delegated cookie; generic setup/login-required page; no internal existence detail |
| 401 `GATEWAY_SESSION_EXPIRED` | Clear expired cookie; owner repair required; no automatic owner login/MFA bypass |
| 401 `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | Canonical terminal state; deny and invalidate delegation as applicable; no reinstall |
| 403 `GATEWAY_CSRF_INVALID` | Deny mutation with no side effect; no retry with weaker origin checks |
| 403 `GATEWAY_SCOPE_DENIED` | Insufficient current scope/membership or unsupported operation; no partial data/effect |
| 409 `AGENT_PAUSED` / canonical case-control codes | Preserve canonical state; no work/action/notification-ack mutation |
| 409 `GATEWAY_CHECK_ACTIVE` | Another run active; include safe retry seconds; no second guard or work claim |
| 409 `GATEWAY_PAIRING_STATE` | Pending/expired/rejected/withdrawn/uncertain pairing; safe state and guidance; do not create another registration |
| 400 `GATEWAY_REQUEST_INVALID` / `GATEWAY_CURSOR_INVALID` | Closed-schema/bounds or cursor mismatch; no mutation; invalid cursor resumes pending projection safely |
| 429 `RATE_LIMITED` | Integer Retry-After; follow run budget, otherwise next scheduled check |
| 503 `GATEWAY_RECOVERY_REQUIRED` | Unknown activation/rotation state; retain journal and refuse until reconciled; never retry non-idempotent creation blindly |
| 503 `GATEWAY_TEMPORARILY_UNAVAILABLE` | Bounded retry; canonical work remains durable; do not advance notification ack or successful-check presence |

Use the canonical error envelope when published; proposed new codes above do not replace existing codes. Body contains safe `code`, `state`, `guidance`, optional `retryAfterSeconds` and request correlation only, with no raw provider error, secret or cross-tenant detail. Pairing errors expose only state of the bound pending browser. Rate limits apply per installation/session and pending source plus existing global limits; a new browser profile cannot reset account/server creation quotas.

`POST /api/agent-gateway/session/end` takes `{}` + CSRF, ends only this delegated browser session, invalidates its CSRF/generation and clears cookie; it does not freeze the agent or erase canonical work. Owner installation revoke remains the established canonical operation, invalidates all its delegated sessions and preserves eligible identity/history. Runtime session sign-out is idempotent and cannot revoke another installation. Browser cookie expiry alone is not agent-wide revocation.

Audit minimal events for publication: `agent.gateway_pairing_created`, `agent.gateway_session_created`, `agent.gateway_session_ended`, `agent.gateway_notification_acknowledged`, `agent.poll_policy_changed`; scoped actor, time, canonical installation, safe reason and request ID only. Check success is throttled presence/metrics, not an unbounded per-page audit log. Existing owner event consumers must register approved new names through their normal additive event contract; no changing CI/tests to ignore emitted events.

## 9. Action boundary and API candidate

No Stage 1 runtime POST can send or mark a case processed. Stage 2 reuses approved CaseSession minting, canonical typed tools, proposals/human decisions, asset gates, idempotency and fresh lease/fence checking. Browser clicks do not create human authority. Before enabling Stage 2, publish the exact installation-scoped operation mapping, action-specific consent evidence and wait/reclaim behavior; do not add a general `/proxy`, arbitrary method/path, raw agent token or second reply store. Required approvals bind exact case/recipient/content/scope and generation; denial or changed details yields no effect and fresh approval. No lease is held while a human or the next tick is awaited. Stage 1 completion is not multi-host collaboration completion.

In parallel, a private API/script client can be tested against the actual Envoi authentication profile using synthetic credentials and approved inert checks. It must demonstrate host-only secret use, correct header/audience, renewal/rotation and revoke outside model-visible prompts/results. A host's statement that it can use saved credentials is capability evidence to test, not an Envoi auth pass. If successful, prefer that private API surface where appropriate; if not, browser delegation remains a candidate. Do not request production credentials or publish private account statements as proof. API clients need their own approved authorization/activation adapter; they do not inherit browser cookies or bypass this contract.

## 10. Fixture specification for canonical publication

These are **proposed fixture IDs and assertions**, not executable canonical fixtures or a Lane B contract publication. Agent authors can draft them; Lane A publishes accepted schemas/fixtures and provenance. Exercise persistence/effect races on FileStore and PostgreSQL, with inert host adapters and no actual provider task/account/network access.

| IDs | Required assertions |
| --- | --- |
| B01–B04 | Flag off/invalid dependencies, legacy v1 route response unchanged, gateway-only REST+poll pairing, ordinary REST client cannot select poll through flat availability |
| B05–B09 | Pending browser has no data rights; correct owner/MFA/membership; wrong-owner/code/comparison phrase; cross-browser pairing; expired/rejected/withdrawn approval |
| B10–B14 | Lost registration response reconciles or safely blocks; identical activation retries create one installation; lost Set-Cookie recovery bound to pending browser/300 s; expired recovery cannot duplicate enrollment; bootstrap/access/refresh never reach output/log/DOM |
| B15–B19 | Owner cookie rejected as runtime auth and delegated cookie rejected as human; session swap/generation/fixation; CSRF/origin/form safety; 24 h idle/7 d absolute boundaries; relink/revoke and uncertain renewal fail closed |
| P01–P05 | Empty/one/multi-page canonical pending work; enqueue-sequence snapshot with concurrent/backdated arrivals; cursor expiry/cross-installation; response/summary/byte limits; remaining work survives five-page budget |
| P06–P10 | Check/render does not claim/ack/settle; alert before notification ack; lost alert response repeats refs; ack replay/mixed invalid batch atomicity; new work version/session replacement/ledger retention |
| P11–P15 | Run overlap/guard timeout/stale ack, minimum interval/Retry-After, canonical outage/crash recovery, same identity/task reuse, disappeared task/reconnect without silent enrollment |
| L01–L05 | Pause blocks data and ack with held work; resume preserves ordering; revoke races per-page/ack; orphaned task has no access; session end is not installation/agent-wide revoke |
| V01–V04 | Check timestamp versus shell/failed auth, exact overdue boundary and clock skew, untrusted schedule report cannot mark closed-app pass, legacy a5 projection unchanged |
| A01–A03 | Stage 1 writes/assets/human decisions denied; model/browser approval spoof denied; Stage 2 remains unavailable without separately approved mapping |

Local fixture success does not prove actual host scheduling. Hosted gate uses exact release/artifact hashes, actual host/product/version, owner-consented setup and the real read-back task; two differently timed app-closed arrivals, missed run/restart, session expiry/reconnect, denied write, pause/resume/revoke and late run rejection. Record alert acceptance and user observation separately. Both hosts stay OPEN until their own promised outcome passes, or an explicit scope change is recorded. Keep this separate from C-A6 integration for other verified routes.

## 11. Exact Je review and implementation exit

| Review ID | What Je must accept or amend | Concrete output needed |
| --- | --- | --- |
| J1 | `authenticated_rest + poll` represents gateway-owned credentials truthfully; gateway-only activation and versioned availability do not enable unreviewed generic clients | Final route/mode amendment, default-off flag dependencies and legacy compatibility fixtures B01–B04 |
| J2 | Pending browser ↔ existing owner claim ↔ server-held activation flow, comparison/owner confirmation and 300 s cookie recovery exception | Final binding/state schemas, approved same-identity reconnect and B05–B14 |
| J3 | 7 d absolute/24 h idle, cookie/CSRF/origin controls, secret custody and rotation, current-policy/effect checks | Final session/error schemas and B15–B19; explicit acceptance or replacement of limits |
| J4 | Canonical monotonic enqueue sequence/index, Stage 1 visibility, pagination and atomic notification-only ack/retention | Name actual canonical data/projection mapping, immutable snapshot semantics and P01–P10 |
| J5 | 30-minute default, run/overlap/retry budgets, task-report provenance, presence precedence and lifecycle behavior | Poll-policy/presence versioning, L/P/V fixtures and no modification of old a4/a5 semantics |
| J6 | Read/notify-only first implementation; exact audit/event consumers, default-off rollout/rollback and separate Stage 2/API auth work | Confirm scoped implementation boundary, additive events and integration/dependency order; no general credential proxy |

Je's work is **server-authority review and canonical contract publication/integration**, not doing all drafting, research, coding or test preparation himself. Assigned agents prepare schema/fixture drafts, implement approved pieces on claimed disjoint paths, test and assemble evidence. Rachel owns product/consent decisions, final `CONTRACT-APPROVED` for the exact published revision and separate live/release approvals. Account-specific private-credential usability is verified privately by the authorized owner/host; no unsupported claim is added to public Git.

Implementation may start only after: J1–J6 are resolved in the published contract/fixture version; Codex posts consuming `CONTRACT-ACK` or resolves MISMATCHs; Rachel posts exact `CONTRACT-APPROVED`; implementation file owners are assigned without overlap. Publication is not deployment, account setup, scheduling or advertised host acceptance. Until then this PR is draft documentation and both hosts remain OPEN.
