import path from 'node:path';

const recoveryDirectory = path.join('auth', 'agent-rotation-recovery');

export async function reapAgentRotationRecovery(store, now = Date.now()) {
  const records = await store.listJson(recoveryDirectory);
  let removed = 0;
  for (const record of records) {
    if (/^[a-f0-9]{64}$/.test(record.tokenHash) && Date.parse(record.expiresAt) <= now) {
      await store.deleteJson(path.join(recoveryDirectory, `${record.tokenHash}.json`));
      removed += 1;
    }
  }
  return removed;
}
