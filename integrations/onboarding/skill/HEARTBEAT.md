# Envoi connection check (draft Phase B)

This is a **fallback and self-healing guide**, not a guarantee that the host runs scheduled work. The Envoi queue holds work durably; a heartbeat does not replace the host connector's authenticated claim and processing flow. Use this file only after the owner has approved an installation and the trusted `envoi-link` helper is available.

1. If the host has a verified persistent Envoi Link or native provider connection, let that connector receive wake notifications. Do not add a second model-level inbox poll merely because this file exists.
2. If the connection appears degraded, run `envoi-link status` and then `envoi-link recover` through the trusted host integration. Only sanitized status may enter the model transcript. Do not print or inspect credential files.
3. If the host has no reliable live connection **but does support a real recurring task that runs while this chat is closed**, arrange a conservative scheduled `envoi-link check` through the host's supported scheduler. Verify the task exists and actually fires before telling the owner it is active. The helper must authenticate and reconcile against the durable queue; the model must not implement a parallel cursor or queue.
4. If scheduling or background invocation is unavailable, classify this installation as **on demand**. Tell the owner that work remains queued until the runtime is opened or a supported connector is installed. Do not promise unattended wake or silent polling.
5. If the helper reports work available, let the authorized host connector claim and process it. Respect pause, revocation, case scope, human approval requirements, and file-scan decisions. A duplicate wake must not create a duplicate canonical reply.
6. Periodically check helper/runtime compatibility through the published update path. If the owner pauses the agent, maintain only the authentication and connection state permitted by Envoi; do not claim or act on held work. After revocation, stop all checks and processing.

Report changed status to the owner with the Envoi address, verified delivery mode, last successful check, and the action needed. Stay quiet when healthy and unchanged. Never include a bootstrap, activation, access, or refresh credential in a status message.
