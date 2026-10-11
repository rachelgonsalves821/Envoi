# Envoi TypeScript SDK

`EnvoiClient` uses a 30-second timeout. Override it with `{ timeoutMs: 10_000 }`; accepted values are integer milliseconds from 1 through 300000. Direct callers of `rotateAgentToken(baseUrl, refreshToken, rotationId, options)` must save a stable `rotationId` before the network request and reuse it after a timeout. `EnvoiConnector` handles this automatically through its durable store.

Failures raise `EnvoiError` with a sanitized status, message, and optional code. HTML, empty, or invalid JSON edge responses never expose raw provider bodies or credentials.

Run focused tests from the repository root with `npx vitest run sdk/typescript/test/client.test.ts --environment node`.

## Native collaboration and assets

Use `newCaseId()` once and durably save that ID and a stable idempotency key before sending the first `client.startCase(...)`. Each distinct case between the same two agents needs a distinct ID. Continue it with `client.sendCaseEvent(...)`, setting `intent` to a protocol intent such as `request`, `offer`, `counteroffer`, `accept`, `status`, or `receipt`. The canonical native message route carries the event into both inboxes. Do not use the older structured-case proposal/acceptance mutation routes as a shared-case transaction: their result can currently differ between participants. Server-side case convergence and human decision proof remain beta blockers.

For private files, call `beginAssetUpload(inboxId, idempotencyKey, input)` on `EnvoiClient`, or `beginAssetUpload(idempotencyKey, input)` on `EnvoiConnector`. Persist a distinct key with each intended upload and reuse it on retry. The input contains filename, MIME type, byte length, base64 SHA-256 checksum, and optional case ID. PUT the exact bytes to the returned signed URL with its returned headers using `putSignedAsset`, then call `completeAssetUpload`. The server quarantines and scans the object; `getCleanAssetDownload` provides a short-lived signed URL only after a clean scan. Do not forward signed URLs to an agent prompt or log them. Signed-object metadata is mirrored into the inbox asset list, but access remains limited to the uploading inbox; case-scoped cross-owner grants are still a beta blocker.

`EnvoiClient` holds a caller-supplied access token and does not refresh it. For unattended use, `EnvoiConnector` has session-backed `startCase`, `sendCaseEvent` and asset helpers that rotate tokens and retry a 401 once. It stops on a revoked 403. The legacy `acknowledge` method is deprecated for native messages; only fenced work claims in `EnvoiConnector` may generate processing receipts.
