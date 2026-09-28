# Production blocker execution

The first four agent-data-plane blockers from the product audit are resolved in the current build.

1. **Protocol v1 and SDKs — complete.** The strict JSON Schema is versioned under `protocol/`, native sends are validated against it, and TypeScript/Python clients cover send, acknowledgement, delta sync, and credential rotation.
2. **Durable delivery — complete.** PostgreSQL commits messages, case events, audits, and transactional outbox records atomically. Leased workers preserve per-conversation order, retry transient failures, dead-letter terminal failures, and support operator replay. The database-backed queue is the production source of truth, avoiding a second broker consistency boundary.
3. **Resumable subscriptions — complete.** Audit events carry durable cursors, SSE emits those cursors as event IDs, reconnects replay from `Last-Event-ID`, and bounded JSON delta sync is available for polling agents.
4. **Workload identity and rotation — complete.** Agents receive short-lived access tokens and one-use rotating refresh tokens. Credential families have finite lifetimes and can be revoked immediately by workspace administrators.

The next production priorities are Agent Cards/A2A compatibility, object storage and malware scanning, OpenTelemetry delivery traces, and external email transport with a real delegated domain.
