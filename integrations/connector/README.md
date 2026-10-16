# Shared connector lifecycle and recovery

The shared connector records STARTING, RUNNING, DEGRADED, PAUSED, NEEDS_RECONNECT,
REVOKED and STOPPED atomically with its credentials in the private session file.
Status and doctor include this lifecycle and operator guidance without credentials.
Paused agents keep refreshing and reading delta events; claims, actions and MCP
requests stop. Runtime tool verification is deferred while paused. A resume event
wakes the claim loop immediately. Stopping the process preserves the pause flag.

Outages use bounded exponential jitter (up to 30 seconds), with Retry-After as a
minimum delay. The retry deadline and pending rotation ID survive restart.
Revoked, replaced or expired credentials require an explicit owner recovery step;
the connector never enrolls automatically. For ROTATION_ID_REQUIRED, update your
connector before reconnecting through Envoi. Preserve the private state directory
when recovering a lost refresh response. Reconnect replaces credentials for the
same agent and preserves a server pause until the owner explicitly resumes it.

## Private Phase B adoption seam

The bundled `envoi-link` entry can call `adoptActivatedConnection(origin, runtime,
activation, resolveAdapter, options)` from `core.ts` after explicit host confirmation
and the private activation credential commit. This accepts only Hermes/OpenClaw
`local_helper` installations with `envoi_link` delivery. It never redeems a legacy
enrollment token or starts a new registration.

Pass `options.stateDir` for the helper's private state directory and the persisted
`options.completionId`. The helper's atomic `session.json` contains normal connector
credentials plus `_onboarding: { completionId, origin, runtime, agent, installation,
effectivePermissions }`; `runtime` is the server-declared `{ type, version }` object.
The connector validates installation, completion, origin and runtime before contacting
Envoi. It preserves newer credentials, rotation recovery state, inbox cursors and
terminal lifecycle state when setup is retried. If the helper has not yet written a
session, the seam can atomically commit that same shape before runtime configuration.

`connection.json.activationSetup` records the completion and installation identifiers.
Configuration failures retain both records for retry with the same helper state.
Authentication status is checked before configuring the runtime; paused attachments
skip tool verification and ready reports. The return value is private caller metadata,
not helper stdout. The caller projects only approved safe fields, then can run
`startConnection` in the foreground using the same directory. Setup does not prove
closed-app wake, and real host validation remains a separate human checkpoint.
