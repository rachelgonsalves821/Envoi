import path from 'node:path';

const settingsPath = inboxId => path.join('inboxes', inboxId, 'config', 'monad-permissions.json');

export function createMonadAccess({ store, available = false, paidOrganizationIds = '' }) {
  const paid = new Set(String(paidOrganizationIds).split(',').map(id => id.trim()).filter(Boolean));

  async function status(inbox) {
    const entitled = paid.has(inbox.organizationId);
    const saved = await store.getJson(settingsPath(inbox.id));
    return { available, entitled, enabled: available && entitled && saved?.enabled === true };
  }

  async function active(inboxId) {
    if (!available) return false;
    const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
    return inbox ? (await status(inbox)).enabled : false;
  }

  async function set(inbox, enabled) {
    if (enabled && !available) throw Object.assign(new Error('Monad is not configured for this deployment'), { statusCode: 409, code: 'MONAD_UNAVAILABLE' });
    if (enabled && !paid.has(inbox.organizationId)) throw Object.assign(new Error('Monad requires a paid organization entitlement'), { statusCode: 403, code: 'MONAD_ENTITLEMENT_REQUIRED' });
    await store.putJson(settingsPath(inbox.id), { enabled, updatedAt: store.now() });
    return status(inbox);
  }

  return { active, status, set };
}
