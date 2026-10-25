import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { Transaction, Wallet } from 'ethers';
import { commitment, createMonadPermissionLayer, permissionSnapshot } from '../src/monad-permissions.js';

const wallet = Wallet.createRandom();
const blockHash = '0x' + 'a'.repeat(64);
const agent = {
  id: 'agent_1', status: 'active', onboardingStatus: 'approved',
  permissions: ['send_agent_messages'], approvedAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z'
};

function fixture({ chainId = '0x279f', finalized = true } = {}) {
  const data = new Map();
  const transactions = new Map();
  let sends = 0;
  const store = {
    getJson: async key => data.get(key),
    putJson: async (key, value) => { data.set(key, value); },
    listJson: async prefix => [...data].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value)
  };
  const request = async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = chainId;
    else if (method === 'eth_gasPrice') result = '0x3b9aca00';
    else if (method === 'eth_getTransactionCount') result = '0x' + sends.toString(16);
    else if (method === 'eth_sendRawTransaction') {
      const tx = Transaction.from(params[0]);
      transactions.set(tx.hash, tx);
      sends += 1;
      result = tx.hash;
    } else if (method === 'eth_getTransactionByHash') {
      const tx = transactions.get(params[0]);
      result = tx ? { from: tx.from, to: tx.to, input: tx.data, value: '0x0', blockHash } : null;
    } else if (method === 'eth_getTransactionReceipt') {
      result = transactions.has(params[0]) ? { blockNumber: '0x1', blockHash, status: '0x1' } : null;
    } else if (method === 'eth_getBlockByNumber') {
      result = params[0] === 'finalized'
        ? { number: finalized ? '0x1' : '0x0', hash: blockHash }
        : { number: '0x1', hash: blockHash, timestamp: '0x10' };
    } else throw new Error('Unexpected RPC method: ' + method);
    return { ok: true, json: async () => ({ id: 1, result }) };
  };
  return { store, request, data, transactions, get sends() { return sends; } };
}

test('current permission is committed, read back, and reused without a second transaction', async () => {
  const rpc = fixture();
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  const first = await layer.ensurePermission('inbox_1', agent);
  assert.equal(first.status, 'recorded');
  assert.equal(rpc.sends, 1);
  assert.equal(rpc.transactions.get(first.txHash).data, commitment('permission', permissionSnapshot('inbox_1', agent)));
  const second = await layer.ensurePermission('inbox_1', agent);
  assert.equal(second.txHash, first.txHash);
  assert.equal(rpc.sends, 1);
  const changed = await layer.ensurePermission('inbox_1', { ...agent, permissions: [] });
  assert.notEqual(changed.txHash, first.txHash);
  assert.equal(rpc.sends, 2);
});

test('unfinalized permission fails closed and retries the same transaction', async () => {
  const rpc = fixture({ finalized: false });
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  await assert.rejects(layer.ensurePermission('inbox_1', agent), /pending/);
  await assert.rejects(layer.ensurePermission('inbox_1', agent), /pending/);
  assert.equal(rpc.sends, 2);
  assert.equal(rpc.transactions.size, 1);
});

test('denied attempts get distinct payload-free transaction commitments', async () => {
  const rpc = fixture();
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  const details = { inboxId: 'inbox_1', agentId: agent.id, method: 'POST', pathname: '/api/agent/work/claim',
    status: 403, reasonCode: 'AGENT_PAUSED', permissionFingerprint: commitment('permission', permissionSnapshot('inbox_1', agent)) };
  const first = await layer.recordViolation({ ...details, requestId: 'one' });
  const second = await layer.recordViolation({ ...details, requestId: 'two' });
  assert.equal(first.status, 'recorded');
  assert.notEqual(first.txHash, second.txHash);
  assert.equal(rpc.transactions.get(first.txHash).data, first.digest);
  assert.equal(rpc.sends, 2);
});

test('wrong chain never sends a permission transaction', async () => {
  const rpc = fixture({ chainId: '0x1' });
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  await assert.rejects(layer.ensurePermission('inbox_1', agent), /Wrong Monad chain/);
  assert.equal(rpc.sends, 0);
});

test('enabled-by-default layer requires a key; explicit zero cap is refused', async () => {
  const rpc = fixture();
  assert.throws(() => createMonadPermissionLayer({ store: rpc.store, privateKey: '', request: rpc.request }), /ISSUER_PRIVATE_KEY/);
  assert.throws(() => createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, maxTransactions: 0 }), /positive integer/);
  assert.equal(rpc.sends, 0);
});

test('configured issuer anchors permissions without a transaction-count cap by default', async () => {
  const rpc = fixture();
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request });
  assert.equal((await layer.ensurePermission('inbox_1', agent)).status, 'recorded');
  assert.equal(layer.budgetStatus().maxTransactions, null);
  assert.equal(rpc.sends, 1);
});

test('policy execution reads a prior commitment without creating one', async () => {
  const rpc = fixture();
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  const policy = { inboxId: 'inbox_1', agentId: agent.id, caseId: 'case_1', recordDigest: 'signed-decision' };
  assert.equal(await layer.readAnchor('policy', policy), null);
  await layer.anchor('policy', policy);
  assert.equal((await layer.readAnchor('policy', policy)).status, 'recorded');
  assert.equal(await layer.readAnchor('policy', { ...policy, recordDigest: 'changed' }), null);
  assert.equal(rpc.sends, 1);
});

test('violation intent survives an RPC outage and is sent by the retry worker', async () => {
  const rpc = fixture();
  let offline = true;
  const request = (url, options) => {
    if (offline) throw new Error('offline');
    return rpc.request(url, options);
  };
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request, enabled: true, maxTransactions: 10 });
  const details = { requestId: 'retry-one', inboxId: 'inbox_1', agentId: agent.id,
    method: 'POST', pathname: '/api/agent/work/claim', status: 403,
    reasonCode: 'AGENT_PAUSED', permissionFingerprint: commitment('permission', permissionSnapshot('inbox_1', agent)) };
  await assert.rejects(layer.recordViolation(details), /offline/);
  assert.equal((await rpc.store.listJson(path.join('monad', 'violation-outbox')))[0].status, 'queued');
  offline = false;
  const [result] = await layer.flushViolations();
  assert.equal(result.status, 'recorded');
  assert.equal(rpc.sends, 1);
});

test('permission evidence distinguishes off, unstamped, and verified state', async () => {
  const rpc = fixture();
  const off = createMonadPermissionLayer({ enabled: false });
  assert.equal((await off.permissionEvidence('inbox_1', agent)).permission.status, 'off');
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  assert.equal((await layer.permissionEvidence('inbox_1', agent)).permission.status, 'not_recorded');
  const stamped = await layer.ensurePermission('inbox_1', agent);
  const evidence = await layer.permissionEvidence('inbox_1', agent);
  assert.equal(evidence.permission.status, 'recorded');
  assert.equal(evidence.permission.txHash, stamped.txHash);
  assert.equal(rpc.sends, 1);
});

test('permission evidence shows only the selected agent denied attempts', async () => {
  const rpc = fixture();
  const layer = createMonadPermissionLayer({ store: rpc.store, privateKey: wallet.privateKey, request: rpc.request, enabled: true, maxTransactions: 10 });
  const details = { inboxId: 'inbox_1', method: 'POST', pathname: '/api/agent/work/claim',
    status: 403, reasonCode: 'AGENT_PAUSED', permissionFingerprint: 'fingerprint' };
  await layer.recordViolation({ ...details, agentId: agent.id, requestId: 'selected' });
  await layer.recordViolation({ ...details, agentId: 'other', requestId: 'other' });
  const evidence = await layer.permissionEvidence('inbox_1', agent);
  assert.deepEqual(evidence.violations.map(item => item.requestId), ['selected']);
  assert.equal(evidence.violations[0].status, 'recorded');
  assert.match(evidence.violations[0].explorerUrl, /testnet.monadexplorer.com/);
});
