# Monad permissions integration

This feature adapts the [Harvard iLabs Envoi hackathon chain module](https://github.com/pjsk02/Hackathon-Harvard-iLabs/tree/main/server/chain) to Envoi's existing agent credentials, permission lists, and signed policy decisions. It is opt in and targets Monad **testnet** (chain ID 10143). It does not deploy a smart contract.

## How enforcement works

1. Envoi authenticates the agent with its existing credential. The server builds a canonical snapshot of the agent's inbox, status, approval state, permissions, and access generation.
2. Before an authenticated REST or MCP request proceeds, Envoi signs a zero value self transaction whose input is a 32 byte commitment to that snapshot. On subsequent requests it reads the transaction, receipt, canonical block, and finalized block again. A changed permission snapshot requires a new finalized transaction. Pending, missing, mismatched, or unavailable chain evidence fails closed with a 503.
3. The existing route checks still select the required permission and enforce case, asset, tenant, contact, and human approval rules. The policy engine's signed decision digest is separately committed on Monad before a decision is returned. Execution reads that prior commitment without creating one retroactively, then re-evaluates and commits the execution decision.
4. An authenticated 403 response, a paused or controlled-case rejection, an unavailable MCP tool, and a denied policy evaluation create a payload-free violation record. The server writes a local outbox intent before broadcasting a separate zero value transaction. A 30 second worker retries unfinished intents with the *same signed bytes and hash* when a prior submission is uncertain. Unknown, expired, or revoked credentials are handled by the existing authentication path and cannot generate funded transactions.

The chain records commitments and their ordering. Envoi's store holds the preimages, issuer identity, request context, and transaction status. A block explorer shows the transaction and its input commitment; the local record is needed to explain the permission or denial. A finalized transaction proves the server issuer submitted that commitment. It does not independently prove a human approved the underlying permission, or that every off-platform agent action was observed.

## Configuration

Set these only for an isolated testnet environment with a dedicated, minimally funded issuer:

```text
ENVOI_MONAD_PERMISSIONS=true
ENVOI_MONAD_RPC_URL=https://testnet-rpc.monad.xyz
ENVOI_MONAD_ISSUER_PRIVATE_KEY=<testnet-only private key>
ENVOI_MONAD_MAX_TRANSACTIONS=<explicit positive integer>
```

The key is required at startup when the feature is enabled. The allowance defaults to zero. Every new permission, policy, or violation commitment consumes one slot; exact signed transaction retries do not. Transactions use at most 30,000 gas and refuse a gas price above 200 gwei. The allowance is **per process**, so coordinate one issuer/writer and a total test spend across restarts. No key or live transaction is needed for the automated tests.

The default remains off because the current service has no shared nonce coordinator for multiple server instances and no production budget ledger. Enabling it on multiple replicas with one issuer is unsupported. A denial is immediate in Envoi; transaction inclusion and finality are asynchronous and may be pending during an RPC outage. The outbox retries after recovery. Do not describe pending evidence as already recorded on chain.

## Hackathon code ported and adapted

- The [ledger](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/ledger.ts) supplied the zero value self transaction, commitment readback, chain ID, gas ceiling, and uncertain broadcast handling.
- The [attempt recorder](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/attempts.ts) supplied the payload-free, distinct attempt commitment and pending/recorded distinction. Envoi uses its own request IDs and a persistent outbox instead of the demo's session receipts.
- The [permission service](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/permission-service.ts) and [EIP-712 slip](https://github.com/pjsk02/Hackathon-Harvard-iLabs/blob/main/server/chain/slip.ts) use a fixed scenario, agent, and expiry. Envoi uses its existing human approved permission list and signed policy record, so those demo-specific types and dispute route were not copied.

## Verification

`node --test test/monad-permissions.test.js` uses a fake RPC and an ephemeral wallet. The focused MCP suites exercise existing transport behavior with this feature off. Live funded issuer and multi-instance tests remain necessary before enabling this outside a controlled testnet deployment.
