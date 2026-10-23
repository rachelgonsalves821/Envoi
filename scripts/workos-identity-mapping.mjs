// Offline preparation / operator-invoked maintenance only. Never imported by the server.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { databaseTargetFingerprint } from '../src/consumer-identity.js';
import { DEPLOYMENT_IDENTITY_PATH } from '../src/deployment-identity.js';

const identityPath = /^(?:humans\/[^/]+\.json|organizations\/[^/]+\/organization\.json|auth\/workos-(?:user|organization)-index\/[^/]+\.json|organizations\/[^/]+\/members\/[^/]+\.json|humans\/[^/]+\/organizations\/[^/]+\.json)$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (ok, code) => { if (!ok) fail(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const clone = value => structuredClone(value);
export const mappingDigest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sortDocuments = documents => clone(documents).sort((a, b) => a.path.localeCompare(b.path, 'en'));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const indexPath = (kind, id) => `auth/workos-${kind}-index/${encodeURIComponent(id)}.json`;

// Deliberately bounded to the reviewed owner-only cohort. Extra humans, organizations,
// memberships or indexes require a newly reviewed inventory, not an email fallback.
export function prepareWorkosIdentityMapping({ documents, users, organizations, databaseFingerprint, deployment, sourceInventoryDigest }) {
  requireValue(/^[a-f0-9]{64}$/.test(databaseFingerprint) && /^[a-f0-9]{64}$/.test(sourceInventoryDigest), 'INVALID_INVENTORY_BINDING');
  requireValue(deployment && /^[a-z][a-z0-9-]{0,31}$/.test(deployment.environment)
    && (deployment.legacyUnstampedReleaseSha === null || /^[a-f0-9]{40}$/.test(deployment.legacyUnstampedReleaseSha)), 'INVALID_DEPLOYMENT_BINDING');
  requireValue(Array.isArray(users) && users.length > 0 && users.length <= 100 && Array.isArray(organizations)
    && organizations.length > 0 && organizations.length <= 100, 'INVALID_MAPPING_SCOPE');
  requireValue(Array.isArray(documents) && documents.length <= 1_000, 'INVALID_DOCUMENT_SCOPE');
  const before = sortDocuments(documents);
  const original = new Map(before.map(d => [d.path, d.value]));
  requireValue(original.size === before.length && before.every(d => identityPath.test(d.path) && d.value && typeof d.value === 'object' && !Array.isArray(d.value)), 'INVALID_IDENTITY_DOCUMENTS');
  const after = new Map(before.map(d => [d.path, clone(d.value)]));
  const covered = new Set();
  const localUsers = new Set(); const localOrganizations = new Set();
  const oldUsers = new Set(); const newUsers = new Set(); const oldOrgs = new Set(); const newOrgs = new Set();
  const take = path => { requireValue(original.has(path) && !covered.has(path), 'MISSING_OR_DUPLICATE_IDENTITY_DOCUMENT'); covered.add(path); return original.get(path); };
  const moveIndex = (kind, from, to, field, localId) => {
    const oldPath = indexPath(kind, from); const newPath = indexPath(kind, to);
    const value = take(oldPath);
    requireValue(value[field] === localId && !original.has(newPath) && !after.has(newPath), 'PROVIDER_INDEX_COLLISION');
    after.delete(oldPath); after.set(newPath, clone(value));
  };
  for (const u of users) {
    requireValue(identifier(u.localHumanId) && u.localHumanId.startsWith('human_') && identifier(u.from) && u.from.startsWith('user_')
      && identifier(u.to) && u.to.startsWith('user_') && u.from !== u.to && !localUsers.has(u.localHumanId)
      && !oldUsers.has(u.from) && !newUsers.has(u.to), 'INVALID_USER_MAPPING');
    localUsers.add(u.localHumanId); oldUsers.add(u.from); newUsers.add(u.to);
    const path = `humans/${u.localHumanId}.json`; const human = take(path);
    requireValue(human.id === u.localHumanId && human.authProvider === 'workos' && human.workosUserId === u.from, 'SOURCE_USER_MISMATCH');
    after.set(path, { ...clone(human), workosUserId: u.to });
    moveIndex('user', u.from, u.to, 'humanId', u.localHumanId);
  }
  requireValue([...newUsers].every(id => !oldUsers.has(id)), 'PROVIDER_USER_ALIAS');
  for (const o of organizations) {
    requireValue(identifier(o.localOrganizationId) && o.localOrganizationId.startsWith('org_') && identifier(o.from) && o.from.startsWith('org_')
      && identifier(o.to) && o.to.startsWith('org_') && o.from !== o.to && !localOrganizations.has(o.localOrganizationId)
      && !oldOrgs.has(o.from) && !newOrgs.has(o.to) && localUsers.has(o.ownerHumanId), 'INVALID_ORGANIZATION_MAPPING');
    localOrganizations.add(o.localOrganizationId); oldOrgs.add(o.from); newOrgs.add(o.to);
    const path = `organizations/${o.localOrganizationId}/organization.json`; const organization = take(path);
    requireValue(organization.id === o.localOrganizationId && organization.ownerHumanId === o.ownerHumanId
      && organization.workosOrganizationId === o.from && organization.status === 'active', 'SOURCE_ORGANIZATION_MISMATCH');
    const member = take(`organizations/${o.localOrganizationId}/members/${o.ownerHumanId}.json`);
    const reference = take(`humans/${o.ownerHumanId}/organizations/${o.localOrganizationId}.json`);
    requireValue(member.humanId === o.ownerHumanId && member.organizationId === o.localOrganizationId && member.role === 'owner'
      && member.status === 'active' && reference.organizationId === o.localOrganizationId && reference.role === 'owner', 'OWNER_MEMBERSHIP_MISMATCH');
    after.set(path, { ...clone(organization), workosOrganizationId: o.to });
    moveIndex('organization', o.from, o.to, 'organizationId', o.localOrganizationId);
  }
  requireValue([...newOrgs].every(id => !oldOrgs.has(id)), 'PROVIDER_ORGANIZATION_ALIAS');
  requireValue(covered.size === original.size, 'INCOMPLETE_MAPPING_COVERAGE');
  const afterDocuments = sortDocuments([...after].map(([path, value]) => ({ path, value })));
  const changes = [...new Set([...original.keys(), ...after.keys()])].sort().flatMap(path => {
    const previous = original.get(path) ?? null; const next = after.get(path) ?? null;
    return isDeepStrictEqual(previous, next) ? [] : [{ path, before: clone(previous), after: clone(next) }];
  });
  const body = { version: 1, databaseFingerprint, deployment: clone(deployment), sourceInventoryDigest,
    users: clone(users), organizations: clone(organizations), beforeDocuments: before, afterDocuments, changes };
  return { ...body, digest: mappingDigest(body) };
}

export function validateWorkosIdentityMapping(manifest) {
  const { digest, ...body } = manifest;
  requireValue(/^[a-f0-9]{64}$/.test(digest) && mappingDigest(body) === digest, 'MAPPING_DIGEST_MISMATCH');
  const expected = prepareWorkosIdentityMapping({ ...manifest, documents: manifest.beforeDocuments });
  requireValue(isDeepStrictEqual(expected, manifest), 'INVALID_MAPPING_TRANSFORM');
  return manifest;
}

function connectedFingerprint(client) {
  const { host, port, database } = client.connectionParameters || {};
  requireValue(typeof host === 'string' && !host.includes('/') && Number.isInteger(Number(port)) && typeof database === 'string', 'UNVERIFIABLE_DATABASE_CONNECTION');
  const url = new URL('postgresql://localhost/'); url.hostname = host.includes(':') ? `[${host}]` : host;
  url.port = String(port); url.pathname = `/${encodeURIComponent(database)}`;
  return databaseTargetFingerprint(url.toString());
}

// Owns a transaction on a dedicated connected pg Client (never a shared Pool).
// Dry-run is the default and uses a READ ONLY transaction. Writes additionally require
// the reviewed digest, a maintenance-window acknowledgement and a recovery-point reference.
export async function executeWorkosIdentityMapping(client, manifest, options = {}) {
  validateWorkosIdentityMapping(manifest);
  const { direction = 'forward', dryRun = true, approvedDigest, maintenanceConfirmed = false, recoveryReference } = options;
  requireValue(direction === 'forward' || direction === 'inverse', 'INVALID_MAPPING_DIRECTION');
  requireValue(typeof dryRun === 'boolean', 'INVALID_DRY_RUN');
  requireValue(connectedFingerprint(client) === manifest.databaseFingerprint, 'DATABASE_TARGET_MISMATCH');
  if (!dryRun) requireValue(approvedDigest === manifest.digest && maintenanceConfirmed === true
    && typeof recoveryReference === 'string' && recoveryReference.trim().length >= 8, 'CUTOVER_APPROVAL_AND_RECOVERY_REQUIRED');
  let begun = false; let committing = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE ${dryRun ? 'READ ONLY' : 'READ WRITE'}`); begun = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    if (!dryRun) await client.query('LOCK TABLE sinaloa_documents IN SHARE ROW EXCLUSIVE MODE');
    const database = await client.query('SELECT current_database() AS name');
    requireValue(database.rows[0]?.name === client.connectionParameters.database, 'DATABASE_NAME_MISMATCH');
    const stamp = (await client.query('SELECT value FROM sinaloa_documents WHERE path = $1', [DEPLOYMENT_IDENTITY_PATH])).rows[0]?.value;
    requireValue(stamp ? stamp.environment === manifest.deployment.environment : Boolean(manifest.deployment.legacyUnstampedReleaseSha), 'DEPLOYMENT_IDENTITY_MISMATCH');
    const readIdentities = async () => sortDocuments((await client.query('SELECT path, value FROM sinaloa_documents WHERE path ~ $1 ORDER BY path', [identityPath.source])).rows);
    const actual = await readIdentities();
    const source = direction === 'forward' ? manifest.beforeDocuments : manifest.afterDocuments;
    const target = direction === 'forward' ? manifest.afterDocuments : manifest.beforeDocuments;
    const alreadyApplied = isDeepStrictEqual(actual, target);
    requireValue(alreadyApplied || isDeepStrictEqual(actual, source), 'IDENTITY_INVENTORY_CHANGED');
    if (!dryRun && !alreadyApplied) {
      for (const change of manifest.changes) {
        const value = direction === 'forward' ? change.after : change.before;
        if (value === null) await client.query('DELETE FROM sinaloa_documents WHERE path = $1', [change.path]);
        else await client.query(`INSERT INTO sinaloa_documents(path, value) VALUES($1, $2)
          ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [change.path, value]);
      }
      requireValue(isDeepStrictEqual(await readIdentities(), target), 'MAPPING_READBACK_FAILED');
    }
    committing = !dryRun;
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT'); begun = false;
    return { status: alreadyApplied ? 'NO_OP' : dryRun ? 'DRY_RUN_VALID' : 'APPLIED', direction, digest: manifest.digest,
      users: manifest.users.length, organizations: manifest.organizations.length, documentWrites: !dryRun && !alreadyApplied ? manifest.changes.length : 0 };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    // SQL errors can contain whole private rows / connection strings. Only expose a code.
    throw Object.assign(new Error('WorkOS identity mapping refused or failed; verify the database read-only before retrying'), {
      code: committing ? 'MAPPING_COMMIT_OUTCOME_UNKNOWN' : /^[A-Z0-9_]{2,80}$/.test(error?.code || '') ? error.code : 'MAPPING_TRANSACTION_FAILED'
    });
  }
}
