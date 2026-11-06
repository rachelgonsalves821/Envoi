# Hermes connection recovery

Use the existing private state directory. A running connector, completed setup,
and a successful peer exchange are separate observations. A new enrollment token
is not a repair for a stopped process, network outage or unloaded Gateway tools.

Start with these read-only commands on the host where Hermes executes:

```sh
node envoi-connector.mjs status --state-dir <existing-private-directory>
node envoi-connector.mjs doctor --state-dir <existing-private-directory>
```

`status` distinguishes an authenticated responding process from a saved check or
an unverified task-manager entry. When a process already owns this connection,
`doctor` asks that owner for its checks instead of starting another relay or
rotating its credentials. An offline preflight is reported as `preflight_only`;
it cannot prove Gateway tool execution or message processing.

| Observation | Meaning and next action |
| --- | --- |
| `status: running`, checks passed | The controlled process reports its checks. Verify a real incoming message and reply before claiming delivery acceptance. |
| `status: stopped` | Start the existing saved connection when you want Hermes active. If you previously chose a startup task, inspect that task's actual process and logs. Keep the identity and journals. |
| `status: unverified` | The control channel, identity or process is not proven. Inspect the existing process before starting a competitor. A scheduler's Running label alone is insufficient. |
| `phase: tool_verification`, `TOOLS_NOT_READY` | With the interim readiness fix, keep this connector running while the Gateway reconciles tools. A new catalog permits another actual proof; it is not itself success. On an older build that exits, preserve state and use its reported saved start command. |
| `ENVOI_UNREACHABLE`, transient tool error | Restore the host's network or wait for Envoi recovery. Keep credentials. A write's outcome can be uncertain: preserve its idempotency key and inspect the outcome before retrying. |
| `GATEWAY_UNREACHABLE` | Restore the selected profile's Gateway when you want Hermes running. Check the saved profile and origin; a shared `/p/<profile>` path is not a supported legacy API origin. |
| `GATEWAY_AUTH_FAILED` | Repair the selected Gateway's local API Server key privately. It is different from the model-provider credential and Envoi token. Do not copy keys between profiles. |
| `MODEL_NOT_READY` | Repair that profile's configured provider/model on its runtime host. Reuse the working provider; enrollment cannot create provider access. |
| `AGENT_PAUSED` | The owner paused this identity. Wait for an explicit resume in Envoi; restarting a Gateway does not restore action rights. |
| `CREDENTIAL_REVOKED`, `NEEDS_RECONNECT` | The owner must review the connection and, when appropriate, reconnect the same existing identity through Envoi. Do not repeatedly redeem a used token or delete journals. |
| Startup `recoveryPolicy: outdated` | The existing optional Windows task lacks the expected recovery/hidden-launch definition. Reinstallation is an owner choice after inspecting the process; it is not performed by status. |
| `HERMES_EXECUTION_UNCERTAIN`, `HERMES_CREATION_UNCERTAIN` | Preserve the turn journal and use settlement/reconciliation. Do not reset enrollment or automatically repeat an uncertain external effect. |

## Private Windows evidence

On the hidden-launch build, the state directory contains `connector.stdout.log`,
`connector.stderr.log` and UTC start/exit history in `connector-supervisor.log`.
The preceding launch's output is retained as `.previous`. Capture the phase,
error code, exit time/code and expected profile/origin. Review logs before sharing:
remove credentials, token fragments, business messages and provider response data.
Do not publish session/configuration files or local control secrets.

The repeating recovery trigger already covers exits independently of the task's
restart-on-failure setting. It does not establish unattended boot, operation while
logged out, or Gateway availability. Task installation is optional and does not
implement automatic startup tied to opening Hermes.

## State in a temporary directory

A default new connection uses persistent private application state. An older
connection with an explicit temporary `--state-dir` needs a deliberate migration;
the product-name migration helper does not relocate arbitrary temporary folders.
Prepare that move while the owner can stop the sole connector and any prior
restart task. Keep the complete session, relay identity and work/turn journals
together. A copy of `session.json` alone loses recovery and deduplication state.

Verify a private target, source/target identity and rollback copy before switching
the start command. Do not reset the saved relay name/token/port or make a second
enrollment. Preserve unrelated Gateway/provider settings. Never run both state
copies. Do not remove the rollback until the new location and a real exchange
have been accepted. Host-specific migration remains owner-controlled.

## Acceptance after release

Test a real exchange, sleep/resume, Wi-Fi loss, brief Envoi unavailability, closing
the launch terminal, reboot/login and a 24-hour idle interval. Record automatic
recovery and any manual intervention. Source tests and enrollment alone do not
prove these outcomes. A stopped Hermes execution runtime cannot execute work;
closing a chat window can leave a separately supervised Gateway running. Catch-up
and automatic connection tied to reopening Hermes belong to the separate
session-lifecycle work, which remains deferred.
