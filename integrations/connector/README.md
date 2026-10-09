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
