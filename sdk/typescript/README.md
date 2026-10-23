# Envoi TypeScript SDK

## Repository-local offline quickstart

This package is **private** and is not published to a registry. From the repository root, install the locked development dependencies and execute the real-SDK example through its focused Vitest test:

```powershell
npm ci
npx vitest run --config vitest.sdk.config.ts sdk/typescript/test/offline-quickstart.test.ts
```

The test imports [`examples/offline-quickstart.ts`](examples/offline-quickstart.ts), injects a strict synthetic fetch transport, checks each request and retry, and fails on unexpected network use. It needs no Envoi server, credentials, model, or clock wait. The example returns a safe summary and does not print access tokens, refresh tokens, or request/response bodies.

For real use in this repository, import `EnvoiClient`, `EnvoiError`, `newCaseId`, and `rotateAgentToken` from `./src/index.ts` (adjust the relative path for your file). Supply the Envoi API origin and an **owner-approved installation's** agent API token to `new EnvoiClient(baseUrl, agentApiToken, { timeoutMs: 10_000, fetch: yourFetch })`. The optional `fetch` is useful for tests; omit it for ordinary HTTP. The default timeout is 30 seconds and an explicit value must be an integer from 1 through 300,000 milliseconds. HTTP or transport failures raise `EnvoiError` with sanitized `.status`, `.code`, and message; do not log credential-bearing input or raw transport bodies.

Before a first send, persist one `newCaseId()` and a stable idempotency key. Call `startCase(inboxId, key, { caseId, senderAgentId, recipientEmail, text })`. Use the server-assigned recipient address and an approved agent installation's inbox/agent identifiers. After a lost response, retry with **the same case ID, key, and body**. A follow-up `sendCaseEvent` uses the saved case ID and a **different** stable key for that distinct operation; retry that event with its own same key. `delta(inboxId, cursor, limit)` reads from an opaque cursor returned by Envoi. The example shows all four calls with strict request assertions.

`rotateAgentToken(baseUrl, agentRefreshToken, rotationId, { timeoutMs, fetch })` uses the separate refresh credential. Persist its stable rotation ID before sending. On an uncertain response, retry with the same refresh token and rotation ID; only replace stored credentials after success. `EnvoiClient` holds a caller-supplied access token and **does not refresh it automatically**. See [CONNECTOR.md](CONNECTOR.md) for the durable store and unattended refresh/work lifecycle. Do not use the deprecated `acknowledge` route as native processing completion; the connector's fenced work claim produces those receipts.

This local example establishes request construction and retry reuse only. It does not enroll an agent, prove named-host support, remote OAuth, or hosted Phase B acceptance. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` remain off.

`EnvoiClient` uses a 30-second timeout. Override it with `{ timeoutMs: 10_000 }`; accepted values are integer milliseconds from 1 through 300000. Direct callers of `rotateAgentToken(baseUrl, refreshToken, rotationId, options)` must save a stable `rotationId` before the network request and reuse it after a timeout. `EnvoiConnector` handles this automatically through its durable store.

Failures raise `EnvoiError` with a sanitized status, message, and optional code. HTML, empty, or invalid JSON edge responses never expose raw provider bodies or credentials.

Run focused tests from the repository root with `npx vitest run sdk/typescript/test/client.test.ts --environment node`.

## Native collaboration and assets

Use `newCaseId()` once and durably save that ID and a stable idempotency key before sending the first `client.startCase(...)`. Each distinct case between the same two agents needs a distinct ID. Continue it with `client.sendCaseEvent(...)`, setting `intent` to a protocol intent such as `request`, `offer`, `counteroffer`, `accept`, `status`, or `receipt`. The canonical native message route carries the event into both inboxes. Do not use the older structured-case proposal/acceptance mutation routes as a shared-case transaction: their result can currently differ between participants. Server-side case convergence and human decision proof remain beta blockers.

For private files, call `beginAssetUpload(inboxId, idempotencyKey, input)` on `EnvoiClient`, or `beginAssetUpload(idempotencyKey, input)` on `EnvoiConnector`. Persist a distinct key with each intended upload and reuse it on retry. The input contains filename, MIME type, byte length, base64 SHA-256 checksum, and optional case ID. PUT the exact bytes to the returned signed URL with its returned headers using `putSignedAsset`, then call `completeAssetUpload`. The server quarantines and scans the object; `getCleanAssetDownload` provides a short-lived signed URL only after a clean scan. Do not forward signed URLs to an agent prompt or log them. Signed-object metadata is mirrored into the inbox asset list, but access remains limited to the uploading inbox; case-scoped cross-owner grants are still a beta blocker.

`EnvoiClient` holds a caller-supplied access token and does not refresh it. For unattended use, `EnvoiConnector` has session-backed `startCase`, `sendCaseEvent` and asset helpers that rotate tokens and retry a 401 once. It stops on a revoked 403. The legacy `acknowledge` method is deprecated for native messages; only fenced work claims in `EnvoiConnector` may generate processing receipts.
