# Cloudflare Containers deployment

This adapter runs one beta Sinaloa application container behind a Cloudflare Worker. All HTTP methods, cookies, CSRF headers, encoded paths, streaming response bodies, and Server-Sent Events pass through to the Node application. Authenticated responses are marked `no-store` at the edge.

The Worker uses a stable Durable Object name and `max_instances: 1`, so every request reaches the same beta container. A one-minute Cron Trigger calls `/ready`; this wakes a stopped container and continually resets the five-minute idle timeout while scheduling is healthy. If multiple application containers are introduced later, move delivery polling to a separately leased worker before increasing `max_instances`.

## Workers Builds

Connect the GitHub repository under **Workers & Pages → sinaloa-inbox → Settings → Builds**.

- Production branch: `main`
- Root directory: `/`
- Build command: `npm ci && npm run build && npm run test:cloudflare`
- Deploy command: `npm run cf:deploy`

Container deployments must use `wrangler deploy`; `wrangler versions upload` does not publish updated container images.

## Runtime configuration

Use Worker variables/secrets rather than committed values. At minimum configure the public URL/CORS/agent domain, external PostgreSQL with `SINALOA_DB_SSL_MODE=verify-full`, private R2 S3 endpoint and bucket, HTTPS scanner, WorkOS callback, and all corresponding credentials. Supply `SINALOA_DB_CA` as a secret only when the provider CA is not trusted by the base image. Set `SINALOA_EDGE_ALLOWED_HOSTS` to `sinaloa-inbox.com` plus any deliberately retained `workers.dev` hostname.

Run `npm run db:migrate` against production PostgreSQL before first traffic and before releases with migrations. Verify `/health` and `/ready` through the deployed hostname; readiness remains `503` until all critical production dependencies are available.
