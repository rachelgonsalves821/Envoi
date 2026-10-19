// Gate B-local read-only status check. Prints ids, enumerated values, counts and times only; never a token, code or message text.
//   node scripts/gate-b-local/check.mjs <FileStore data dir> [--origin https://localhost:8443]
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Usage: node scripts/gate-b-local/check.mjs <data dir> [--origin <origin>]');
const originIndex = process.argv.indexOf('--origin');
const origin = originIndex > 0 ? process.argv[originIndex + 1] : 'https://localhost:8443';
const originKey = createHash('sha256').update(origin).digest('hex').slice(0, 24);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const walk = (d, out = []) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const short = (v) => typeof v === 'string' ? v.replace(/^([a-z_]+_[0-9a-f]{8})[0-9a-f-]+$/, '$1…') : v;
const files = walk(dataDir);

console.log('== registrations');
for (const p of files.filter((p) => /[\\/]agent-registrations[\\/]registration_[^\\/]+\.json$/.test(p))) {
  const j = read(p);
  console.log(' ', j.id, j.status, j.target?.kind ?? '-', j.target?.address ?? '', 'created', j.createdAt, 'approved', j.approvedAt ?? '-', 'activated', j.activatedAt ?? '-', 'inst', short(j.installationId ?? '-'), 'agent', short(j.agentId ?? j.target?.agentId ?? '-'));
}
console.log('== installations');
for (const p of files.filter((p) => /[\\/]agent-installations[\\/].*installation_[^\\/]+\.json$/.test(p))) {
  const j = read(p);
  console.log(' ', j.id, 'agent', short(j.agentId), j.connectionRoute, j.deliveryMode, 'family', short(j.credentialFamilyId), 'activated', j.activatedAt, 'legacy', j.legacy ?? false);
}
console.log('== credential families');
for (const p of files.filter((p) => /[\\/]agent-credential-families[\\/].*\.json$/.test(p))) {
  const j = read(p);
  console.log(' ', basename(p, '.json'), 'revokedAt', j.revokedAt ?? null, 'reason', j.revokedReason ?? null);
}
console.log('== presence');
for (const p of files.filter((p) => /[\\/]agent-presence[\\/].*\.json$/.test(p))) {
  const j = read(p);
  console.log(' ', short(basename(p, '.json')), 'seen', j.lastSeenAt, 'claim', j.lastWorkClaimAt, 'processed', j.lastProcessedAt);
}
console.log('== inboxes, agents, events');
for (const ib of existsSync(join(dataDir, 'inboxes')) ? readdirSync(join(dataDir, 'inboxes')) : []) {
  const dir = join(dataDir, 'inboxes', ib);
  const inbox = read(join(dir, 'inbox.json'));
  const agents = existsSync(join(dir, 'agents')) ? readdirSync(join(dir, 'agents')).map((f) => read(join(dir, 'agents', f))) : [];
  console.log(' ', ib, inbox.kind, agents.map((a) => `${a.id} ${a.address} ${a.status}/${a.onboardingStatus} ${a.name ?? ''}`).join('; '));
  const counts = ['messages', 'work-claims', 'delivery-receipts', 'cases'].map((s) => existsSync(join(dir, s)) ? `${s}=${readdirSync(join(dir, s)).length}` : null).filter(Boolean).join(' ');
  if (counts) console.log('    ', counts);
  const events = readdirSync(join(dir, 'events')).map((f) => read(join(dir, 'events', f))).sort((a, b) => a.sequence - b.sequence);
  for (const e of events) {
    const keep = ['target', 'installationId', 'connectionRoute', 'deliveryMode', 'credentialFamilyId', 'messageId', 'senderAgentId', 'recipientAgentId', 'workId', 'agentId', 'address'].filter((k) => e[k] !== undefined && typeof e[k] !== 'object').map((k) => `${k}=${short(e[k])}`);
    console.log('    ', e.sequence, e.type, e.createdAt, keep.join(' '));
  }
}
console.log('== server log');
const log = join(dirname(dataDir), `server-${basename(dataDir).replace('data-', '')}.log`);
if (existsSync(log)) {
  const raw = readFileSync(log);
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  const created = text.split(/\r?\n/).filter((l) => l.includes('agent_registration.created'));
  console.log('  agent_registration.created lines:', created.length);
}
console.log('== helper state');
const helperRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'envoi', 'onboarding') : null;
for (const rt of ['hermes', 'openclaw']) {
  const d = helperRoot && join(helperRoot, rt, originKey);
  if (!d || !existsSync(d)) { console.log(' ', rt, 'none'); continue; }
  const h = existsSync(join(d, 'helper-state.json')) ? read(join(d, 'helper-state.json')) : null;
  const sc = existsSync(join(d, 'setup-check.json')) ? read(join(d, 'setup-check.json')) : null;
  const s = existsSync(join(d, 'session.json')) ? read(join(d, 'session.json')) : null;
  console.log(' ', rt, 'phase', h?.phase ?? '-', 'setup', sc ? `${sc.checks} ${sc.checkedAt}` : '-', 'lifecycle', s?.lifecycle ? `${s.lifecycle.state}${s.lifecycle.code ? ' ' + s.lifecycle.code : ''}` : '-');
}
