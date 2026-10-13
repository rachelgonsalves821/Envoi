import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Gate GA evidence extractor. The operator saves an owner JSON view from a signed-in staging browser
// tab (events/delta, agents, delivery-receipts or deliveries) to a private file; this prints only
// allow-listed, publishable fields as a Markdown table. Message text, lease tokens, provider ids,
// error strings and anything unlisted are dropped, so a saved view can never leak into evidence.
// It reads a local file only: no network, no cookie, no credential.
export const EVIDENCE_FIELDS = Object.freeze({
  events: ['sequence', 'id', 'type', 'createdAt', 'agentId', 'workId', 'messageId', 'caseId', 'fence', 'attempts',
    'credentialFamilyId', 'credentialFamilyCount', 'retryable', 'reasonCode', 'retryAt', 'refreshExpiresAt',
    'reason', 'runtime', 'phase'],
  agents: ['id', 'address', 'status', 'paused', 'credentialRevoked', 'connection.state', 'connection.asOf', 'connection.seenAt',
    'connection.credentialExpiresAt', 'connection.presence.lastSeenAt', 'connection.presence.lastSuccessfulRefreshAt',
    'connection.presence.lastWorkClaimAt', 'connection.presence.lastProcessedAt'],
  receipts: ['createdAt', 'id', 'type', 'state', 'messageId', 'senderAgentId', 'recipientAgentId', 'attempt'],
  deliveries: ['id', 'messageId', 'status', 'attempts', 'maxAttempts', 'availableAt', 'deliveredAt', 'deadLetteredAt']
});

const read = (item, field) => field.split('.').reduce((value, key) => (value == null ? undefined : value[key]), item);
const cell = value => (value === undefined ? '' : String(value === null ? 'null' : Array.isArray(value) ? value.join(' ') : value)).replace(/[|\r\n]/g, ' ');

// A field value is published only when it is a scalar or a list of scalars. Strings are capped: an
// allow-listed field never holds free text, so a long one means the shape is not what we expect.
// Fields a client chooses and could fill with text: published only in their machine-readable form.
const CODE_FIELDS = new Set(['reasonCode']);

function publishable(value, field) {
  if (CODE_FIELDS.has(field) && value != null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new Error(`${field} is not an upper-case code; refusing to publish client text`);
  }
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 160) throw new Error('An allow-listed field held unexpected long text; refusing to publish it');
    if (/envoi_(?:agent|mcp|enroll|reg)_|Bearer\s/i.test(value)) throw new Error('A field looked like a credential; refusing to publish it');
    return value;
  }
  if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) return value.map(item => publishable(item));
  throw new Error('An allow-listed field held a nested value; refusing to publish it');
}

export function extractEvidence(kind, payload, { since } = {}) {
  const fields = EVIDENCE_FIELDS[kind];
  if (!fields) throw new Error(`Usage: node scripts/ga-evidence.mjs ${Object.keys(EVIDENCE_FIELDS).join('|')} <saved-view.json> [--since <ISO time>]`);
  const items = kind === 'events' ? payload?.events : payload;
  if (!Array.isArray(items)) throw new Error(`The saved ${kind} view is not the expected list`);
  const sinceMs = since === undefined ? null : Date.parse(since);
  if (since !== undefined && Number.isNaN(sinceMs)) throw new Error('--since must be an ISO time');
  // Deliveries have no stable creation time (availableAt moves on retry), so they are not filtered.
  const timeField = { events: 'createdAt', agents: null, receipts: 'createdAt', deliveries: null }[kind];
  if (since !== undefined && !timeField) throw new Error(`--since does not apply to ${kind}`);
  const rows = items
    .filter(item => sinceMs === null || !timeField || Date.parse(read(item, timeField)) >= sinceMs)
    .map(item => fields.map(field => publishable(read(item, field), field)));
  if (!rows.length) return `No ${kind} matched.`;
  if (kind === 'events') rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  // A column is dropped only when no row has the field at all; an explicit null (deadLetteredAt) is evidence.
  const used = fields.filter((_, index) => rows.some(row => row[index] !== undefined));
  const columns = used.map(field => fields.indexOf(field));
  return [
    `| ${used.join(' | ')} |`,
    `| ${used.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(index => cell(row[index])).join(' | ')} |`)
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [kind, file, ...rest] = process.argv.slice(2);
    const sinceIndex = rest.indexOf('--since');
    const since = sinceIndex === -1 ? undefined : rest[sinceIndex + 1];
    if (sinceIndex !== -1 && !since) throw new Error('--since needs an ISO time');
    if (!file) throw new Error(`Usage: node scripts/ga-evidence.mjs ${Object.keys(EVIDENCE_FIELDS).join('|')} <saved-view.json> [--since <ISO time>]`);
    console.log(extractEvidence(kind, JSON.parse(await readFile(file, 'utf8')), { since }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
