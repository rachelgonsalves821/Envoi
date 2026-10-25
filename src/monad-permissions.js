import path from 'node:path';
import { keccak256, Wallet } from 'ethers';

// Adapted from the hackathon's permission stamp and attempt-recording modules.
// Transactions carry only a 32-byte commitment, never agent or request data.
export const MONAD_TESTNET_CHAIN_ID = 10143;
const GAS_LIMIT = 30_000n;
const MAX_GAS_PRICE = 200_000_000_000n;
const HEX32 = /^0x[0-9a-f]{64}$/i;

export function permissionSnapshot(inboxId, agent) {
  return {
    version: 1, inboxId, agentId: agent.id, status: agent.status,
    onboardingStatus: agent.onboardingStatus,
    permissions: [...new Set(agent.permissions || [])].sort(),
    accessGeneration: agent.accessGeneration || 0,
    approvedAt: agent.approvedAt || null, revokedAt: agent.revokedAt || null,
    updatedAt: agent.updatedAt || null
  };
}

export function commitment(kind, value) {
  return keccak256(Buffer.from(JSON.stringify(['envoi.' + kind + '.v1', value])));
}

export function violationRecord({ requestId, inboxId, agentId, method, pathname, status, reasonCode, permissionFingerprint }) {
  return { version: 1, requestId, inboxId, agentId, method, pathname,
    status, reasonCode, permissionFingerprint };
}

const hexNumber = value => Number.parseInt(value, 16);
const timeout = ms => AbortSignal.timeout(Math.max(1, ms));

export function createMonadPermissionLayer({ store, enabled = true, rpcUrl = process.env.ENVOI_MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz',
  privateKey = process.env.ENVOI_MONAD_ISSUER_PRIVATE_KEY, maxGasPrice = MAX_GAS_PRICE,
  maxTransactions = process.env.ENVOI_MONAD_MAX_TRANSACTIONS ? Number(process.env.ENVOI_MONAD_MAX_TRANSACTIONS) : Infinity,
  request = fetch, now = Date.now, operationMs = 8_000 } = {}) {
  if (!enabled) return { enabled: false, ensurePermission: async () => null,
    recordViolation: async () => null, anchor: async () => null, readAnchor: async () => null,
    permissionEvidence: async () => ({ enabled: false, chainId: MONAD_TESTNET_CHAIN_ID,
      permission: { status: 'off' }, violations: [] }) };
  if (!store || !privateKey) throw new Error('Monad permissions require a store and ENVOI_MONAD_ISSUER_PRIVATE_KEY');
  if (maxTransactions !== Infinity && (!Number.isSafeInteger(maxTransactions) || maxTransactions <= 0))
    throw new Error('ENVOI_MONAD_MAX_TRANSACTIONS must be a positive integer when set');
  const signer = new Wallet(privateKey);
  let queue = Promise.resolve();
  let reservedTransactions = 0;
  const serialized = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const recordPath = (kind, digest) => path.join('monad', kind, digest.toLowerCase() + '.json');

  async function rpc(method, params, deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Monad operation timed out');
    const response = await request(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: timeout(remaining)
    });
    if (!response.ok) throw new Error('Monad RPC unavailable');
    const body = await response.json();
    if (body.id !== 1 || body.error || !Object.hasOwn(body, 'result')) throw new Error('Monad RPC rejected the request');
    return body.result;
  }

  async function checkedRpc(method, params, deadline) {
    if (hexNumber(await rpc('eth_chainId', [], deadline)) !== MONAD_TESTNET_CHAIN_ID) throw new Error('Wrong Monad chain');
    return rpc(method, params, deadline);
  }

  async function verify(txHash, digest, deadline) {
    const [tx, receipt, finalized] = await Promise.all([
      checkedRpc('eth_getTransactionByHash', [txHash], deadline),
      checkedRpc('eth_getTransactionReceipt', [txHash], deadline),
      checkedRpc('eth_getBlockByNumber', ['finalized', false], deadline)
    ]);
    if (!tx || !receipt || !finalized || !receipt.blockNumber) return null;
    const blockNumber = hexNumber(receipt.blockNumber);
    if (hexNumber(finalized.number) < blockNumber) return null;
    const block = await checkedRpc('eth_getBlockByNumber', [receipt.blockNumber, false], deadline);
    if (!block || receipt.blockHash?.toLowerCase() !== block.hash?.toLowerCase()
      || tx.blockHash?.toLowerCase() !== block.hash?.toLowerCase()
      || tx.from?.toLowerCase() !== signer.address.toLowerCase()
      || tx.to?.toLowerCase() !== signer.address.toLowerCase()
      || tx.input?.toLowerCase() !== digest.toLowerCase()
      || BigInt(tx.value) !== 0n || hexNumber(receipt.status) !== 1) throw new Error('Monad evidence does not match the commitment');
    return { txHash, blockNumber, blockHash: block.hash, blockTimestamp: hexNumber(block.timestamp),
      explorerUrl: 'https://testnet.monadexplorer.com/tx/' + txHash };
  }

  async function anchor(kind, value) {
    const digest = commitment(kind, value);
    if (!HEX32.test(digest)) throw new Error('Invalid Monad commitment');
    return serialized(async () => {
      const deadline = now() + operationMs;
      const key = recordPath(kind, digest);
      let record = await store.getJson(key);
      if (record?.txHash) {
        const verified = await verify(record.txHash, digest, deadline);
        if (verified) {
          if (record.status !== 'recorded') await store.putJson(key, { ...record, status: 'recorded', anchor: verified, raw: null });
          return { status: 'recorded', digest, ...verified };
        }
        // An unknown broadcast keeps its original signed bytes and nonce.
        if (!record.raw) return { status: 'pending', digest, txHash: record.txHash };
      } else {
        if (reservedTransactions >= maxTransactions) throw new Error('Monad transaction allowance is exhausted');
        const gasPrice = BigInt(await checkedRpc('eth_gasPrice', [], deadline));
        if (gasPrice <= 0n || gasPrice > maxGasPrice) throw new Error('Monad gas price exceeds the configured ceiling');
        const nonce = hexNumber(await checkedRpc('eth_getTransactionCount', [signer.address, 'pending'], deadline));
        const raw = await signer.signTransaction({ type: 0, chainId: MONAD_TESTNET_CHAIN_ID,
          to: signer.address, value: 0n, data: digest, gasLimit: GAS_LIMIT, gasPrice, nonce });
        record = { kind, value, digest, txHash: keccak256(raw), raw, status: 'pending', createdAt: new Date(now()).toISOString() };
        await store.putJson(key, record);
        reservedTransactions += 1;
      }
      try {
        const returnedHash = await checkedRpc('eth_sendRawTransaction', [record.raw], deadline);
        if (returnedHash?.toLowerCase() !== record.txHash.toLowerCase()) throw new Error('Monad returned an unexpected hash');
      } catch {
        // A timeout or nonce error may mean delivery succeeded. Never mint a replacement.
        return { status: 'pending', digest, txHash: record.txHash };
      }
      const verified = await verify(record.txHash, digest, deadline);
      if (!verified) return { status: 'pending', digest, txHash: record.txHash };
      await store.putJson(key, { ...record, raw: null, status: 'recorded', anchor: verified });
      return { status: 'recorded', digest, ...verified };
    });
  }

  async function readAnchor(kind, value) {
    const digest = commitment(kind, value);
    const record = await store.getJson(recordPath(kind, digest));
    if (!record?.txHash) return null;
    const verified = await verify(record.txHash, digest, now() + operationMs);
    return verified ? { status: 'recorded', digest, ...verified } : null;
  }

  async function ensurePermission(inboxId, agent) {
    const result = await anchor('permission', permissionSnapshot(inboxId, agent));
    if (result.status !== 'recorded') throw new Error('Monad permission stamp is pending');
    return result;
  }

  async function recordViolation(details) {
    const record = violationRecord(details);
    const outboxPath = path.join('monad', 'violation-outbox', record.requestId + '.json');
    const previous = await store.getJson(outboxPath);
    if (!previous) await store.putJson(outboxPath, { record, status: 'queued', createdAt: new Date(now()).toISOString() });
    const result = await anchor('violation', record);
    await store.putJson(outboxPath, { record, status: result.status, txHash: result.txHash, createdAt: previous?.createdAt || new Date(now()).toISOString() });
    return { ...result, record };
  }

  async function flushViolations(limit = 100) {
    const pending = (await store.listJson(path.join('monad', 'violation-outbox')))
      .filter(item => item.status !== 'recorded').slice(0, limit);
    const results = [];
    for (const item of pending) {
      try { results.push(await recordViolation(item.record)); }
      catch { results.push({ status: 'pending', requestId: item.record.requestId }); }
    }
    return results;
  }

  async function permissionEvidence(inboxId, agent) {
    const snapshot = permissionSnapshot(inboxId, agent);
    const digest = commitment('permission', snapshot);
    const stored = await store.getJson(recordPath('permission', digest));
    let permission = { status: 'not_recorded', digest };
    if (stored?.txHash) {
      try {
        const verified = await readAnchor('permission', snapshot);
        permission = verified || { status: 'pending', digest, txHash: stored.txHash };
      } catch {
        permission = { status: 'unavailable', digest, txHash: stored.txHash };
      }
    }
    const violations = (await store.listJson(path.join('monad', 'violation-outbox')))
      .filter(item => item.record?.inboxId === inboxId && item.record?.agentId === agent.id)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 20)
      .map(item => ({ requestId: item.record.requestId, method: item.record.method,
        pathname: item.record.pathname, reasonCode: item.record.reasonCode,
        createdAt: item.createdAt, status: item.status,
        ...(item.txHash ? { txHash: item.txHash } : {}),
        ...(item.status === 'recorded' && item.txHash
          ? { explorerUrl: 'https://testnet.monadexplorer.com/tx/' + item.txHash } : {}) }));
    return { enabled: true, chainId: MONAD_TESTNET_CHAIN_ID, permission, violations };
  }

  return { enabled: true, ensurePermission, recordViolation, flushViolations, anchor, readAnchor, verify, permissionEvidence,
    budgetStatus: () => ({ maxTransactions: Number.isFinite(maxTransactions) ? maxTransactions : null, reservedTransactions }) };
}
