import crypto from 'node:crypto';
import { hostname } from 'node:os';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Compare destinations without publishing hostnames, database names or credentials.
// Explicit URL routing prevents PG* environment fallback from changing the destination.
export function databaseTargetFingerprint(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('DATABASE_URL must contain an explicit PostgreSQL host and database');
  }
  const routingKeys = ['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password', 'service', 'options'];
  if (routingKeys.some(key => url.searchParams.has(key))) throw new Error('DATABASE_URL query routing overrides are not supported');
  let database;
  let host;
  try { database = decodeURI(url.pathname.slice(1)); host = decodeURIComponent(url.hostname); } catch { throw new Error('DATABASE_URL has an invalid destination encoding'); }
  if (host.includes('/')) throw new Error('DATABASE_URL must use an explicit TCP host');
  const port = Number(url.port || 5432);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DATABASE_URL has an invalid port');
  // Match node-postgres: database uses decodeURI, host uses decodeURIComponent.
  return sha256(JSON.stringify([host.toLowerCase(), String(port), database]));
}

export function assertDatabaseTarget(connectionString, expected) {
  const actual = databaseTargetFingerprint(connectionString);
  if (expected !== undefined && expected !== '') {
    if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) throw new Error('ENVOI_EXPECTED_DATABASE_FINGERPRINT does not match the configured database target');
  }
  return actual;
}

export function createConsumerIdentity({ connectionString, releaseSha = null, instanceId = crypto.randomUUID(), host = hostname() } = {}) {
  if (releaseSha !== null && !/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error('Consumer release SHA must be a full lowercase Git SHA');
  if (!/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error('Consumer instance ID must be a UUID');
  const instanceTag = instanceId.replaceAll('-', '').slice(0, 12);
  return Object.freeze({ workerId: `delivery_${instanceId}`, instanceTag, releaseSha,
    hostTag: sha256(host).slice(0, 16), processId: process.pid,
    backend: connectionString ? 'postgres' : 'file',
    databaseFingerprint: connectionString ? databaseTargetFingerprint(connectionString) : null,
    applicationName: `envoi:${releaseSha || 'unknown'}:${instanceTag}` });
}

// Deliberately allowlist every field: records contain text, payloads and lease tokens.
export function consumerLogger(identity, write = entry => console.info(JSON.stringify(entry))) {
  const { workerId, instanceTag, releaseSha, hostTag, processId, backend, databaseFingerprint } = identity;
  return (event, record = {}) => {
    const entry = { event: `envoi.queue_consumer.${event}`, workerId, instanceTag, releaseSha, hostTag, processId, backend, databaseFingerprint };
    for (const key of ['id', 'messageId', 'orderingKey', 'recipientInboxId']) {
      if (typeof record[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record[key]) && !/(?:envoi|sinaloa)_(?:agent|mcp|enroll|reg)_|Bearer/i.test(record[key])) entry[key] = record[key];
    }
    if (['RECIPIENT_DIRECTORY_MISSING', 'RECIPIENT_DIRECTORY_STATUS', 'RECIPIENT_DIRECTORY_INBOX_MISMATCH'].includes(record.reasonCode)) entry.reasonCode = record.reasonCode;
    if (['processing', 'delivered', 'deadLettered', 'retrying', 'held'].includes(record.status)) entry.status = record.status;
    if (Number.isSafeInteger(record.attempts) && record.attempts >= 0) entry.attempts = record.attempts;
    // Logging failures cannot turn successful delivery into a retry.
    try { write(entry); } catch { /* delivery state remains authoritative */ }
  };
}

export function parseConsumerApplicationName(value) {
  const match = /^envoi:([a-f0-9]{40}|unknown):([a-f0-9]{12})$/.exec(String(value));
  return match ? { role: 'api-delivery', releaseSha: match[1] === 'unknown' ? null : match[1], instanceTag: match[2] }
    : { role: 'unattributed', releaseSha: null, instanceTag: null };
}
