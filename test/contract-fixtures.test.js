import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

test('contract fixture registry has a versioned shape', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  assert.equal(Number.isInteger(index.version) && index.version >= 1, true);
  assert.equal(Array.isArray(index.contracts), true);
  const ids = new Set();
  for (const contract of index.contracts) {
    assert.match(contract.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(contract.id), false, `duplicate contract id ${contract.id}`);
    ids.add(contract.id);
    assert.equal(Number.isInteger(contract.version) && contract.version >= 1, true, contract.id);
    assert.ok(['published', 'approved'].includes(contract.status), contract.id);
    assert.equal(typeof contract.handoff, 'string', contract.id);
    assert.equal(contract.dir, contract.id);
    assert.equal(Array.isArray(contract.fixtures) && contract.fixtures.length > 0, true, contract.id);
  }
});

test('every registered fixture exists, parses and is registered exactly once', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  for (const contract of index.contracts) {
    const dir = path.join(root, contract.dir);
    const onDisk = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    assert.deepEqual([...contract.fixtures].sort(), onDisk, `${contract.id} fixture list`);
    for (const name of contract.fixtures) await readJson(path.join(dir, name));
  }
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, index.contracts.map((contract) => contract.dir).sort(), 'unregistered fixture directory');
});
