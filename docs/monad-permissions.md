# Monad permissions integration

This feature adapts the [Harvard iLabs Envoi hackathon chain module](https://github.com/pjsk02/Hackathon-Harvard-iLabs/tree/main/server/chain) to Envoi's existing agent credentials, permission lists, and signed policy decisions. It is a paid, per-agent-inbox opt-in and targets Monad **testnet** (chain ID 10143). It does not deploy a smart contract. Standard Envoi permissions work when Monad is off.

## How enforcement works

1. Envoi authenticates the agent with its existing credential. For an entitled organization whose workspace administrator enabled Monad for this agent inbox, the server builds a canonical snapshot of the agent's inbox, status, approval state, permissions, and access generation.
2. Before an authenticated REST or MCP request proceeds, Envoi signs a zero value self transaction whose input is a 32 byte commitment to that snapshot. On subsequent requests it reads the transaction, receipt, canonical block, and finalized block again. A changed permission snapshot requires a new finalized transaction. Pending, missing, mismatched, or unavailable chain evidence fails closed with a 503.
3. The existing route checks still select the required permission and enforce case, asset, tenant, contact, and human approval rules. The policy engine's signed decision digest is separately committed on Monad before a decision is returned. Execution reads that prior commitment without creating one retroactively, then re-evaluates and commits the execution decision.
4. An authenticated 403 response, a paused or controlled-case rejection, an unavailable MCP tool, and a denied policy evaluation create a payload-free violation record. The server writes a local outbox intent before broadcasting a separate zero value transaction. A 30 second worker retries unfinished intents with the *same signed bytes and hash* when a prior submission is uncertain. Unknown, expired, or revoked credentials are handled by the existing authentication path and cannot generate funded transactions.

The chain records commitments and their ordering. Envoi's store holds the preimages, issuer identity, request context, and transaction status. A block explorer shows the transaction and its input commitment; the local record is needed to explain the permission or denial. A finalized transaction proves the server issuer submitted that commitment. It does not independently prove a human approved the underlying permission, or that every off-platform agent action was observed.

## Configuration

Before starting Envoi, set a dedicated, minimally funded testnet issuer in the deployment's secret configuration:

```text
ENVOI_MONAD_RPC_URL=https://testnet-rpc.monad.xyz
ENVOI_MONAD_ISSUER_PRIVATE_KEY=<testnet-only private key>
ENVOI_MONAD_PERMISSIONS=true
ENVOI_MONAD_PAID_ORGANIZATION_IDS=<comma-separated entitled organization IDs>
```

For the Cloudflare deployment, add `ENVOI_MONAD_ISSUER_PRIVATE_KEY` as an encrypted Worker secret in each environment being deployed (for example, `wrangler secret put ENVOI_MONAD_ISSUER_PRIVATE_KEY --env beta`). The Worker forwards this secret into its single container. Fund that address on Monad testnet before turning on the global switch; do not place the key in `wrangler.jsonc`, a PR, or chat. Set `ENVOI_MONAD_PERMISSIONS=true` only after the key is present. An explicit true with a missing key fails startup; the default false lets the standard product run without a key.

An Envoi administrator initially grants paid access by adding organization IDs to `ENVOI_MONAD_PAID_ORGANIZATION_IDS` in deployment configuration. This is a server-side entitlement allowlist; Envoi does not yet have billing checkout or subscription webhooks. An authorized workspace administrator can then turn Monad on or off for each agent inbox in Permissions. The server checks the current entitlement and inbox setting for every agent request; losing the entitlement disables new chain enforcement even if the saved switch remains on. Existing permission checks continue to apply in either mode.

The transaction-count allowance is unlimited when `ENVOI_MONAD_MAX_TRANSACTIONS` is unset; an optional positive integer caps new permission, policy, and violation commitments per process. Exact signed transaction retries do not consume another slot. Transactions use at most 30,000 gas and refuse a gas price above 200 gwei. Coordinate one issuer/writer across the deployment. Automated suites explicitly disable the live server integration and use a fake RPC for Monad-specific tests.

Multiple replicas sharing one issuer remain unsupported because the current service has no shared nonce coordinator. Do not run this integration on multiple writers. Without a transaction-count cap, spending is bounded only by the dedicated wallet's funds and the per-transaction gas-price ceiling. A denial is immediate in Envoi; transaction inclusion and finality are asynchronous and may be pending during an RPC outage. The outbox retries earlier intents after recovery even if the inbox switch is turned off. Do not describe pending evidence as already recorded on chain. `ENVOI_MONAD_PERMISSIONS=false` is a deployment-wide rollback.

## Hackathon code ported and adapted

- The [ledger](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/ledger.ts) supplied the zero value self transaction, commitment readback, chain ID, gas ceiling, and uncertain broadcast handling.
- The [attempt recorder](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/attempts.ts) supplied the payload-free, distinct attempt commitment and pending/recorded distinction. Envoi uses its own request IDs and a persistent outbox instead of the demo's session receipts.
- The [permission service](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/permission-service.ts) and [EIP-712 slip](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/slip.ts) use a fixed scenario, agent, and expiry. Envoi uses its existing human approved permission list and signed policy record, so those demo-specific types and dispute route were not copied.

## Verification

`node --test test/monad-access.test.js test/monad-permissions.test.js worker/router.test.js` checks entitlement, opt-in, secret forwarding, and the chain flow with a fake RPC and ephemeral wallet. Live funded issuer and multi-instance tests remain necessary before enabling this outside a controlled testnet deployment.
