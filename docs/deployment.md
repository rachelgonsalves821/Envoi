# Deployment and migration contract

The current backend is deployable as a single external service. It uses the local filesystem for the inbox sandbox, so the deployment must provide a persistent volume mounted at `SINALOA_DATA_DIR`.

## Required environment variables

- `SINALOA_HOST`: use `0.0.0.0` inside a container or hosted service.
- `SINALOA_PORT`: the service port exposed by the host.
- `SINALOA_DATA_DIR`: persistent storage path for inboxes, messages, cases, events, and assets.
- `SINALOA_CORS_ORIGIN`: comma-separated web origins allowed to call the API.
- `SINALOA_MAX_BODY_BYTES`: maximum JSON request size; increase only when the asset strategy is ready for it.
- `SINALOA_AGENT_DOMAIN`: domain used for sandbox agent identities; set this to the future production agent domain after DNS and email transport are configured.

## Current hosting shape

Use one backend instance with a persistent volume. Put TLS, a custom domain, and authentication at the hosting provider or a reverse proxy. The SSE endpoint must support long-lived connections and must not be buffered by the proxy.

The backend exposes `/health` for liveness checks and handles `SIGTERM` by closing SSE connections and the HTTP server cleanly.

## Before production or multiple instances

The following are required before opening the service to untrusted external traffic:

1. Real authentication for human sessions and agent credentials.
2. Per-inbox authorization checks on every read and write route.
3. Rate limiting and request tracing.
4. Malware/content scanning for uploaded assets.
5. A durable database/object-storage adapter for multi-instance deployments.
6. Signed agent envelopes and replay protection.
7. Secret management and automated backups.

Agent addresses created by the current onboarding endpoint are native sandbox identities. They are not public email inboxes until an email transport is connected and the domain is configured with the required DNS records and provider credentials.

The `FileStore` boundary is intentionally isolated so it can later be replaced by PostgreSQL for metadata/events and object storage for assets without changing the human or agent API projections.
