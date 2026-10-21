// Gate B-local row 17: prove a revoked OpenClaw credential is refused for send, refresh and work claim.
// It refuses to run unless the server's FileStore shows the OpenClaw credential family revoked, so it can
// never send a real message. It prints only HTTP status and error code, never a token or message text.
//   $env:ROW17_CASE_ID = '<existing case id>'; node scripts/gate-b-local/row17-revoked-probe.mjs <FileStore data dir> [--origin https://localhost:8443]
// The operator approves the probe send first. Its recipient and idempotency key are the e8a958f run's
// (hermes-gateway@envoi.mail, gate-b-local-e8a958f-row17-revoked-send). The as-run source is commit 6d10a3f; since then
// (Rachel's review on #170, 6305156369) each check must return exactly 401 CREDENTIAL_REVOKED, and anything else exits 1.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Usage: node row17-revoked-probe.mjs <data dir> [--origin <origin>]');
const originIndex = process.argv.indexOf('--origin');
const origin = originIndex > 0 ? process.argv[originIndex + 1] : 'https://localhost:8443';
const originKey = createHash('sha256').update(origin).digest('hex').slice(0, 24);
const stateDir = join(process.env.LOCALAPPDATA, 'envoi', 'onboarding', 'openclaw', originKey);
const session = JSON.parse(readFileSync(join(stateDir, 'session.json'), 'utf8'));
const walk = (d, out = []) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };

// 1. Guard: every credential family of the helper's agent must be revoked on the server.
const families = walk(join(dataDir, 'auth', 'agent-credential-families')).filter(p => p.endsWith('.json'))
  .map(p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } })
  .filter(f => f && f.agentId === session.agentId);
if (!families.length) throw new Error(`STOP: no credential family for ${session.agentId} in the data dir.`);
const live = families.filter(f => !f.revokedAt);
if (live.length) throw new Error(`STOP: ${live.map(f => f.id).join(', ')} not revoked (revokedAt null). Revoke the installation first; this probe never sends with a live credential.`);
for (const f of families) console.log(`guard: ${f.id} revokedAt ${f.revokedAt} reason ${f.revokedReason || f.reason || null}`);

const inboxId = session.inboxId || session.agentInboxId;
const agentId = session.agentId;
const call = async (label, method, path, { token, body, idempotencyKey } = {}) => {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
  const res = await fetch(`${origin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let code = null; try { code = (await res.json()).code ?? null; } catch {}
  console.log(`${new Date().toISOString()} ${label}: HTTP ${res.status} code ${code}`);
  return res.status === 401 && code === 'CREDENTIAL_REVOKED';
};

// 2. Send with the revoked access token, in the existing case, to Hermes.
const send = await call('send (revoked access token)', 'POST', `/api/inboxes/${inboxId}/messages`, {
  token: session.agentApiToken, idempotencyKey: 'gate-b-local-e8a958f-row17-revoked-send',
  body: { senderAgentId: agentId, recipientEmail: 'hermes-gateway@envoi.mail', caseId: process.env.ROW17_CASE_ID, intent: 'message', text: 'Row 17 probe: this send must be refused.' }
});
// 3. Refresh with the revoked refresh token.
const refresh = await call('refresh (revoked refresh token)', 'POST', '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: session.agentRefreshToken, rotationId: `row17probe${Date.now()}` } });
// 4. Claim work with the revoked access token.
const claim = await call('work claim (revoked access token)', 'POST', '/api/agent/work/claim', { token: session.agentApiToken, body: {} });
const refused = send && refresh && claim;
console.log(refused ? 'RESULT: all three refused with 401 CREDENTIAL_REVOKED' : 'RESULT: NOT ALL REFUSED WITH 401 CREDENTIAL_REVOKED (stop condition)');
if (!refused) process.exitCode = 1;
