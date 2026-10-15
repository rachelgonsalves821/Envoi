# Beta runtime reliability acceptance

This supplements the [Phase A runbook](PHASE-A-HOSTED-RUNBOOK.md) and its existing 23 observations. It does not replace the Lane A evidence template or the human release countersign. Preparing or merging this plan does not mean its checks passed.

## Current evidence and release boundary

Real-host testing found genuine Envoi MCP tool discovery failures after relay downtime and interruptions of the supervised disposable runtime. Repairs restored actual tool verification and a canonical message exchange. **Connector-only restart, long-offline discovery recovery and process continuity remain UNPROVEN.** Do not close these gaps with a successful startup, a cached status file, tools/list, or the original reply.

The current staging test stays frozen at `ebfb2c49baccbb02ccca50e37ec1dec4ccac4894`. Do not merge or deploy this draft during that test. Record observations from that release separately from any later implementation. If a failed gate requires a code fix, follow L5: integrate and deploy a human-approved candidate, then rerun all 23 observations on that exact SHA.

## Prerequisites and evidence

- Pin Envoi SHA, connector SHA256, runtime version/profile, supervisor configuration and the private persistent state directory. Use a disposable owner and a sender belonging to a different owner account.
- Lane B controls only the disposable runner; Je/Lane A retains ordered server audit events, credential-family IDs, work/message/case IDs, attempts/fences and canonical receipts. The owner performs sign-in, pause/resume and final revoke when prompted.
- Save authenticated owner agent views before stop, while offline and after recovery. Retain exact connection/presence timestamps. Save raw JSON privately outside Git; publish only the allow-listed evidence extractor output. A UI presence label is not a timestamp export. Missing required views leave the affected observation UNPROVEN.
- Record live PID identity/creation time, supervisor/task state and fresh authenticated runtime probes. Old status-file timestamps are not proof that a process is alive. Do not publish process command lines, cookies, API keys, provider credentials, claim leases or operational tokens.
- Decide the permitted host availability scope before testing: awake/signed-in receiving, login-start receiving, or a separately supported unattended boot service. Never treat one scope as proof of another.

## Required probes

| Probe | Action | Required PASS evidence | Current result |
| --- | --- | --- | --- |
| R1: real tool discovery at cold start | Start the selected disposable profile and unmodified connector with its saved identity. Test actual authenticated Envoi tool use through the model/runtime. | Fresh real tool verification; identity matches saved installation; no fabricated schemas, callback injection, disabled verification or secret exposure. tools/list alone is insufficient. | UNPROVEN for release acceptance |
| R2: connector-only restart (Phase A 3–4) | Record Gateway PID, stop only connector, suppress automatic restart, preserve state, save offline owner view. Je sends one controlled message and returns message ID, case ID and UTC send time. Only then restart connector. | Same Gateway process, agent/address and credential family; offline delivery precedes processing; one processed receipt and canonical reply; no re-enrollment or duplicate effect. | UNPROVEN |
| R3: long-offline MCP recovery | Repeat R2 with relay unavailable for at least five minutes and through any observed parking/cooldown threshold; record actual interval. Also test crossing access-token expiry without editing expiry fields. | Genuine tools become usable again within the declared bounded recovery time; queued work is processed once with the original family; no Gateway restart, manual config toggling or emergency bootstrap needed to label connector-only recovery PASS. | UNPROVEN |
| R4: independent process continuity | Under the agreed awake/signed-in scope, close the launching terminal and browser/chat, then wait at least 15 minutes before Je sends controlled work. | Supervisor/runtime/connector remain live outside the terminal job; message is independently claimed and replied to once without reopening chat or manually restarting. Record actual duration; this is not an indefinite-uptime guarantee. | UNPROVEN |
| R5: unexpected process exit | In a separate owner-approved window, terminate only a verified disposable connector process. Do not confuse this with an operator-held offline checkpoint or terminal revocation. | Supervisor notices exit and restarts within its configured bounded policy; same saved identity/family; queued work completes once. A clean status file with dead processes fails. | UNPROVEN |
| R6: login startup | With owner approval, perform an actual sign-out/sign-in or host restart outside the main 23-row run. Keep private state and avoid interrupting normal agents. | Task/service really starts the intended profile; fresh authenticated tools and queued-work reply work after login, without a manual bootstrap. Publish timestamps/results only. | UNPROVEN |
| R7: offline host and honest availability | Separately test the selected host's supported sleep/logout/offline behavior and recovery; do not assume work executes while the host cannot run. | Work remains durable and catches up once; UI/docs state the actual limitation. Before-login or logged-out receiving is advertised only after its own supported service test. | UNPROVEN |
| R8: revoked/paused supervision safety | Correlate with Phase A pause/resume and final revoke. | Paused agent stays paused through restart; refresh is allowed but work is not processed. Terminal revocation does not trigger re-enrollment or a restart loop restoring access. | UNPROVEN |

## Failure handling

Keep the original failure and UTC time, sanitized category (for example TOOLS_NOT_READY), observed process state and the exact recovery intervention. An owner-approved Gateway restart or temporary genuine-relay bootstrap may restore service, but it **does not pass R2/R3**. Label it recovery-assisted and open the responsible runtime/adapter/supervision defect. Never mark a repaired demonstration as proof that unattended recovery already works.

Declare a bounded recovery deadline before each probe, based on the documented runtime/supervisor policy. If discovery exceeds it, fails or silently loses work, record FAIL rather than waiting indefinitely or shortening the outage after the fact. Distinguish an observed exit category from an established root cause; interruption alone does not identify who or what stopped the process.

## Before inviting real users

- Complete the existing 23-row hosted gate, these reliability probes for the availability scope being offered, server/client evidence correlation and human countersign. Do not silently waive a failed restart or continuity probe.
- Review the beta release checklist through Lane A: backup/rollback, required configuration, matching app/scanner credentials, protected existing data-encryption key, deployment checks and test-agent reconnect. This document authorizes no merge, deployment or credential change.
- Repeat applicable probes on each runtime/version/host advertised as automatically reachable. Local OpenClaw/Grok adapter tests or a Hermes success do not certify another actual host.
- Keep guided connector beta acceptance separate from Phase B skill/helper/MCP OAuth self-onboarding. Draft skills, fixture reviews and authenticated existing-agent MCP reads do not prove a new enrollment route.

Lane A owns the authoritative server evidence and release checklist; Lane B supplies these runner observations. Only the human signs off beta readiness.
