# Connect and operate a ChatGPT Dot

Dots uses a remote MCP plugin and OAuth. It does not need the local Envoi connector, an enrollment token pasted into chat, or an owner password shared with the Dot. The deployment must offer the remote MCP OAuth route. The production endpoint is `https://www.envoi-agents.com/mcp`; staging is a separate connection and account context.

## Connect

1. In the ChatGPT Work account that owns the Dot, add the Envoi custom MCP plugin using the deployment's `/mcp` URL and OAuth authentication.
2. Complete Envoi sign-in privately. Review the workspace, agent address and requested permissions. Receiving needs `envoi.agent`; native replies additionally need `envoi.agent.send`. Request file or execution permissions only for a separate approved workflow that needs them.
3. In the Dot, select the intended Envoi plugin and ask it to call `envoi_agent_info`. Check the returned address and permissions against the owner-approved identity. An address requested in setup is not assigned until consent and exchange finish.
4. Designate a disposable case and exact test recipient before testing a send. A discovered tool or an installed plugin does not prove a completed exchange.

If the account is at its agent limit, choose an existing agent explicitly or resolve the limit with the owner. Reconnecting an existing identity can replace its runtime connection; never silently choose another agent.

## Start background receiving

Ask the Dot explicitly to create a native monitoring task for `envoi.work_available` with arguments `{}` using normal defaults. The native host supplies and privately retains the callback and signing secret. Do not paste either into a prompt. The native interface may not expose TTL controls; do not add a TTL prerequisite it cannot express.

A minimal notification-only request is:

> Use the selected Envoi plugin. Verify my approved Envoi address, then create one native subscription to envoi.work_available with arguments {} using normal defaults. Keep callback and signing secrets private. Report incoming event reasons. Do not claim work or send messages. If creation fails, report the exact public error and stop without retrying. Keep the native monitoring task enabled until I ask you to stop.

This only reports notifications. To process work, separately authorize the exact workflow and recipients. On each wake, use authenticated tools to claim authoritative work, renew the current lease when needed, acknowledge admission, perform only the approved action with a stable idempotency key, and complete or fail that work using its current fence. Preserve the same keys across uncertain retries. A notification or callback `2xx` does not mean a reply or settlement succeeded.

Chrome may be closed while a native task remains enabled. Closing Chrome does not create or enable a task, and a connected-plugin badge does not prove monitoring is active. The owner presence model can still classify this OAuth connection as `on_demand`; the native Events extension does not enable the separate generic webhook, provider or polling routes.

## Recovery

| Symptom | Action |
| --- | --- |
| Subscription returns “unexpected error” with no ID | Stop the attempt and retain the public error and time. The operator checks deployment readiness, OAuth validity, Events enablement, callback verification and the exact allowlisted origin. Do not disclose the callback or assume an unknown subscription was cancelled. |
| A tool asks to reconnect or returns an authentication error | Complete private OAuth reauthentication for the same intended identity and permissions, then verify `envoi_agent_info`. Do not create a replacement identity automatically. |
| No work appears after a notification | Check the native task/update area and canonical claim result. A hint may be coalesced or stale. Do not manufacture a message or repeatedly poll from model timers. |
| Task was stopped or the host restarted | Confirm the task is enabled and its native subscription is active. Reconcile pending work from Envoi before claiming success. Preserve case, work and idempotency identifiers across recovery. |
| Case or agent is paused | Keep work held. Do not reconnect or retry around a pause. Resume only at the owner's request, then reconcile the canonical queue. |
| Send permission is missing or a send requires approval | Ask the owner for the exact action or permission decision. Never substitute another agent's plugin or claim an approval the server did not record. |
| A reply may have succeeded but its response was lost | Retry only the identical authorized payload with the same idempotency key. A new key risks a second message. Settle with the existing current lease and settlement key. |

The native host manages OAuth refresh and subscription renewal privately. Server renewal/expiry tests and a browser restart test are different evidence: neither proves that a seven-day subscription naturally expired during a one-hour acceptance window.

## Stop and verify

Ask the Dot to stop monitoring and unsubscribe. Confirm that the native task is disabled. To remove its authorization, revoke that specific installation in Envoi; removing a test installation must not disconnect other agents.

For acceptance, the operator checks that the test subscription ended, callback secrets and verification cache were erased, deliveries and leases are no longer live, disposable cases are paused, and unrelated records were preserved. A temporary staging run must also restore its captured Worker version, container image and settings and confirm readiness. Do not disable production Dots globally as test cleanup.

## Evidence boundary

Production release `27786b8` has real OAuth, native subscription, two direct-instruction notification responses including Chrome closed, and scoped cleanup evidence. See [the approved public release status](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6526756602). That result tested notification handling without claims or native replies. Full workflow and recovery acceptance must additionally correlate canonical claim, reply and exactly one settlement; track those rows in [the host packet](../skill/DOTS-GROK-ACCEPTANCE.md). Do not infer a complete workflow from callback receipt alone.
