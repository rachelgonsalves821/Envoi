import path from 'node:path';

const recoveryDirectory = path.join('auth', 'agent-rotation-recovery');
// agent-registration §14.5: the 60 s envelopes of OAuth refresh rotations. Reaped here after expiresAt, like A1's.
const oauthRecoveryDirectory = path.join('auth', 'agent-oauth-refresh-recovery');

async function reap(store, directory, now) {
  const records = await store.listJson(directory);
  let removed = 0;
  for (const record of records) {
    if (/^[a-f0-9]{64}$/.test(record.tokenHash) && Date.parse(record.expiresAt) <= now) {
      await store.deleteJson(path.join(directory, `${record.tokenHash}.json`));
      removed += 1;
    }
  }
  return removed;
}

export async function reapAgentRotationRecovery(store, now = Date.now()) {
  return await reap(store, recoveryDirectory, now) + await reap(store, oauthRecoveryDirectory, now);
}
