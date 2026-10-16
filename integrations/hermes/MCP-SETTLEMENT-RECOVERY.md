# Hermes reply settlement during an SSE outage

The connector's safety poll must continue discovering work when SSE is unavailable. A model's successful MCP reply and the later end of its model run are separate events.

Repeated transient SSE connection errors previously updated the same persisted retry deadline used for REST claims. Further reconnect failures could keep moving that deadline forward and postpone the safety poll. The stream now uses its own reconnect delay and Retry-After handling without changing the REST retry deadline. Terminal authentication errors, pause, revocation, credential-refresh failures and REST failures still use the existing lifecycle guards and backoff. This shared SDK fix applies to all runtimes using the TypeScript connector.

Previously the Hermes adapter inspected its durable MCP-write marker only after the model run reported `completed`. A successful reply could therefore remain unsettled while the provider continued generating or retried its connection. Loss of the work lease during that interval caused cancellation and a later reclaim. The existing marker prevented another reply, but settlement was unnecessarily delayed.

The adapter now checks the trusted, durable marker between status polls. After a confirmed native MCP reply, it requests that the recorded model run stop, persists the existing `{stop:true}` decision, and returns to the connector for fenced completion. It does not submit another model run or REST reply. Only the relay's successful-write hook creates the marker; model text is not evidence of a successful tool write.

The connector still owns lease renewal, final completion, pause and revocation enforcement. An abort while checking the marker or stopping the run does not authorize completion. Human instructions do not use the native MCP marker shortcut. Failed marker persistence must remain an error.

## Evidence and retest

- Keep the failed or inconclusive original observation. Do not edit its messages or mark it passed after changing the connector.
- Pin the server SHA, connector artifact hash and proxy hash independently. A local connector patch is not the original frozen candidate or a full hosted-gate pass.
- Obtain approval before installing a real connector, restarting it, introducing an SSE fault, or sending a fresh live message.
- Verify SSE is blocked, REST remains available, the original case remains paused, and the recipient retains the same enrollment and credential family.
- Use a fresh case/message and literal expected ACK. Require one model submission, one successful MCP effect, one exact reply, one processed event and receipt. For the clean retest also require the first fence/attempt and no connector restart during delivery.
- A model run intentionally stopped after its successful MCP effect is not expected to report `completed`. Correlate its run ID and the trusted MCP marker with the server reply and final work receipt instead. A cancelled run without a confirmed write is not success.
- Restore SSE, inject acknowledgement faults or revoke access only under their separate approvals.

The October 16 Send 5 trace proves polling pickup, one exact reply and one processed receipt, but also contains a second claim. The adapter's delayed marker check is reproduced by regression tests. The precise original lease-renewal/cancellation trigger was not captured and must not be presented as proven from that trace alone.

The deterministic SDK regression reproduces polling starvation before the fix. The local-server regression blocks every SSE attempt, introduces new work after an idle claim, performs a real local MCP write while the fake Hermes run remains running, and requires one first-fence claim and one final event/receipt. These local tests do not replace an approved hosted retest.
