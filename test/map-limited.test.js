import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimited } from '../src/map-limited.js';

test('bounded reads preserve input order while several are in flight', async () => {
  let active = 0;
  let maximum = 0;
  const release = [];
  const mapped = mapLimited([0, 1, 2, 3, 4], 2, async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => release.push(resolve));
    active--;
    return value * 10;
  });
  assert.equal(maximum, 2);
  assert.equal(release.length, 2);
  release[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.equal(release.length, 3);
  release[0]();
  await new Promise(resolve => setImmediate(resolve));
  release[2]();
  await new Promise(resolve => setImmediate(resolve));
  release[3]();
  await new Promise(resolve => setImmediate(resolve));
  release[4]();
  assert.deepEqual(await mapped, [0, 10, 20, 30, 40]);
});
