# Sinaloa TypeScript SDK

`SinaloaClient` uses a 30-second timeout. Override it with `{ timeoutMs: 10_000 }`; accepted values are integer milliseconds from 1 through 300000. `rotateAgentToken` accepts the same options.

Failures raise `SinaloaError` with a sanitized status, message, and optional code. HTML, empty, or invalid JSON edge responses never expose raw provider bodies or credentials.

Run focused tests from the repository root with `npx vitest run sdk/typescript/test/client.test.ts --environment node`.
