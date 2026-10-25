---
name: monad-anchor
description: Write or debug server/chain/ledger.ts and mockLedger.ts - anchoring a 32-byte fingerprint on Monad testnet with ethers v6, reading it back, getting chain time, RPC fallback, nonce queue and Monad-specific gas/finality gotchas. Use for any Monad, RPC, transaction, explorer or MOCK_CHAIN work.
---

# Monad anchoring (ledger.ts)

Adapted for Envoi from the community `monskills` Monad skills (gas, block-states, why-monad) and Monad's docs. Envoi uses **no smart contract**: an anchor is a zero-value transaction from the issuer to itself whose `data` field is the slip's EIP-712 digest.

## Network facts

| Item | Value |
| --- | --- |
| Chain ID | 10143 (Monad testnet) |
| RPCs, in fallback order | `process.env.MONAD_RPC_URL` (default `https://testnet-rpc.monad.xyz`), `https://rpc-testnet.monadinfra.com`, `https://rpc.ankr.com/monad_testnet` |
| Explorer | `https://testnet.monadvision.com/tx/{txHash}` |
| Secrets | `ISSUER_PRIVATE_KEY`, `MONAD_RPC_URL` (set in Workspace Secrets AND in the deployment's production secrets) |
| Library | ethers v6 only |

## Exports (frozen interface)

```ts
anchor(digest: string): Promise<{ txHash; blockNumber; blockTimestamp; explorerUrl }>
lookup(txHash: string): Promise<{ from; data; blockNumber; blockTimestamp; status } | null>
latestTimestamp(): Promise<number>   // unix seconds of latest Monad block
```

`mockLedger.ts` exports the same three functions with no network. `server/chain/index.ts` (or the importer) picks mock when `process.env.MOCK_CHAIN === "1"`.

## Reference implementation

```ts
import { JsonRpcProvider, Wallet } from "ethers";

const CHAIN_ID = 10143;
const URLS = [
  process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
  "https://rpc-testnet.monadinfra.com",
  "https://rpc.ankr.com/monad_testnet",
];
const explorer = (h: string) => `https://testnet.monadvision.com/tx/${h}`;

// staticNetwork: skip chainId probing. batchMaxCount 1: monadinfra rejects JSON-RPC batches.
const providers = URLS.map((u) => {
  const p = new JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  p.pollingInterval = 300; // ethers default 4000 ms would add up to 4 s to every wait()
  return p;
});

function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("Monad did not answer in time")), ms))]);
}
// Read calls: try primary, then retry once on the next URL.
async function read<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const p of providers.slice(0, 2)) {
    try { return await withTimeout(fn(p)); } catch (e) { last = e; }
  }
  throw last;
}

let wallet: Wallet | null = null;
function issuer() {
  if (!process.env.ISSUER_PRIVATE_KEY) throw new Error("ISSUER_PRIVATE_KEY is not set");
  return (wallet ??= new Wallet(process.env.ISSUER_PRIVATE_KEY, providers[0]));
}

// Single-file queue: on Monad, "pending" nonce == "latest", so two quick sends collide.
let queue: Promise<unknown> = Promise.resolve();
export function anchor(digest: string) {
  const job = queue.then(async () => {
    const w = issuer();
    const tx = await withTimeout(w.sendTransaction({
      to: w.address, value: 0n, data: digest, chainId: CHAIN_ID,
      gasLimit: 30000n, // Monad bills the gas LIMIT; 21000 + 16/non-zero byte of a 32-byte payload is <= 21512
    }));
    let rc;
    try { rc = await tx.wait(1, 10000); }
    catch (e) {                                   // timed out after broadcast: check once before giving up,
      const seen = await lookup(tx.hash).catch(() => null);   // otherwise the next send may reuse the nonce
      if (!seen) throw e;
      return { txHash: tx.hash, blockNumber: seen.blockNumber, blockTimestamp: seen.blockTimestamp, explorerUrl: explorer(tx.hash) };
    }
    if (!rc || rc.status !== 1) throw new Error("The notary stamp transaction failed on Monad");
    const block = await read((p) => p.getBlock(rc.blockNumber));
    return { txHash: tx.hash, blockNumber: rc.blockNumber, blockTimestamp: Number(block!.timestamp), explorerUrl: explorer(tx.hash) };
  });
  queue = job.catch(() => undefined);
  return job;
}

const cache = new Map<string, any>();
export async function lookup(txHash: string) {
  if (cache.has(txHash)) return cache.get(txHash);
  const tx = await read((p) => p.getTransaction(txHash));
  if (!tx || tx.blockNumber == null) return null;          // unknown or not yet mined
  const rc = await read((p) => p.getTransactionReceipt(txHash));
  const block = await read((p) => p.getBlock(tx.blockNumber!));
  const out = { from: tx.from, data: tx.data, blockNumber: tx.blockNumber, blockTimestamp: Number(block!.timestamp), status: rc?.status ?? 0 };
  cache.set(txHash, out);                                   // mined txs never change
  return out;
}

export async function latestTimestamp() {
  try { const b = await read((p) => p.getBlock("latest")); return Number(b!.timestamp); }
  catch { console.warn("latestTimestamp: falling back to server clock"); return Math.floor(Date.now() / 1000); }
}
```

## Gotchas (check these first when something is wrong)

- **Seconds vs milliseconds.** `block.timestamp` is seconds. `Date.now()` is ms. Every Envoi time is unix seconds.
- **Several blocks share a timestamp.** Monad makes blocks every ~0.4 s, so timestamps tie. Compare with `<=`, never `<`, for "stamped before request".
- **Gas is charged on the limit**, not gas used (`gas_paid = gas_limit * price`). Keep the explicit limit; never set a huge one. Cost is ~0.002–0.003 test MON per anchor.
- **Never send value from the issuer.** Monad's 10 MON reserve-balance rule only bites on value transfers; zero-value anchors are fine at any balance.
- **`getTransaction` returns null while a tx is pending** (Monad's mempool is not queryable). Treat null as "no stamp yet", which the bouncer reports as a failed `stamped` check (fail closed).
- **Finality.** A receipt appears when a block is proposed and is final ~0.8 s later. `wait(1)` is fine for the demo; `lookup` reads again at check time anyway.
- **Do not scan logs.** `eth_getLogs` is capped at ~100 blocks on public RPCs. Always look up by tx hash.
- **Rate limits.** ~25 rps on the public RPC. The cache and one call per check keep you well under.
- **Explorer lag.** The explorer can take seconds to index. The UI should show your own readback (block number + time) and treat the explorer link as a bonus.
- **Faucet.** If the issuer runs dry, `faucet.monad.xyz`. Check balance with `provider.getBalance(address)`.

## Mock ledger

```ts
import { issuerAddress } from "./slip";   // `from` must equal the issuer, or "stamped" always fails on the mock
const store = new Map<string, { data: string; ts: number; block: number }>();
let block = 1;
export async function anchor(digest: string) {
  const txHash = "0xmock" + Math.random().toString(16).slice(2).padEnd(60, "0");
  const ts = Math.floor(Date.now() / 1000); store.set(txHash, { data: digest, ts, block: ++block });
  return { txHash, blockNumber: block, blockTimestamp: ts, explorerUrl: "#mock" };
}
export async function lookup(txHash: string) {
  const r = store.get(txHash); if (!r) return null;
  return { from: issuerAddress(), data: r.data, blockNumber: r.block, blockTimestamp: r.ts, status: 1 };
}
export async function latestTimestamp() { return Math.floor(Date.now() / 1000); }
```

The mock still needs `ISSUER_PRIVATE_KEY` set (any test key works) because `issuerAddress()` derives from it.

## Acceptance check (run from the Replit Shell)

1. `GET /api/health` shows `mockChain:false` and the issuer address.
2. Anchor a test digest, `lookup` it: `from` = issuer, `data` = digest, `status` = 1, round trip under 3 s.
3. Open the explorer URL; it resolves within a few seconds.
