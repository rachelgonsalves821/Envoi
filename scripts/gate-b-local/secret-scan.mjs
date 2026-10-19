// Gate B-local stop-condition check: does any helper secret appear outside the helpers' private state?
// It loads the secrets from both runtimes' helper state into memory and searches the given folders for the exact
// values. It prints only file paths, secret labels and counts, never a value.
//   node scripts/gate-b-local/secret-scan.mjs [--origin https://localhost:8443] <folder or file>...
// Typical roots: the Hermes profile, Hermes logs, ~/.openclaw, the OpenClaw temp logs, the agent workdir and views.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const originIndex = args.indexOf('--origin');
const origin = originIndex >= 0 ? args.splice(originIndex, 2)[1] : 'https://localhost:8443';
if (!args.length) throw new Error('Usage: node scripts/gate-b-local/secret-scan.mjs [--origin <origin>] <folder or file>...');
const originKey = createHash('sha256').update(origin).digest('hex').slice(0, 24);
const helperRoot = join(process.env.LOCALAPPDATA ?? '.', 'envoi', 'onboarding');

const secrets = [];
for (const rt of ['hermes', 'openclaw']) {
  const d = join(helperRoot, rt, originKey);
  const read = (f) => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return {}; } };
  const session = read('session.json'), control = read('control.json'), relay = read('hermes-relay.json'), connection = read('connection.json');
  const add = (label, v) => { if (typeof v === 'string' && v.length >= 20) secrets.push({ label: `${rt}.${label}`, v: Buffer.from(v) }); };
  add('agentApiToken', session.agentApiToken); add('agentRefreshToken', session.agentRefreshToken);
  add('control.secret', control.secret); add('relay.token', relay.token); add('apiServerKey', connection.configuration?.apiKey);
  for (const [k, v] of Object.entries(connection.configuration ?? {})) if (/token|secret|key/i.test(k) && k !== 'apiKey') add(`connection.${k}`, v);
}
console.log('secrets loaded:', secrets.map((s) => s.label).join(', ') || 'none');

let files = 0;
const hits = [];
const scan = (p) => {
  let st; try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) {
    if (/node_modules|[\\/]\.?venv$|site-packages/i.test(p)) return;
    for (const e of readdirSync(p)) scan(join(p, e));
    return;
  }
  if (st.size > 200 * 1024 * 1024) return;
  let buf; try { buf = readFileSync(p); } catch { return; }
  files++;
  for (const s of secrets) {
    let n = 0, i = 0; while ((i = buf.indexOf(s.v, i)) !== -1) { n++; i += s.v.length; }
    if (n) hits.push(`${p} :: ${s.label} x${n}`);
  }
};
for (const root of args) scan(root);
console.log('files scanned:', files);
console.log(hits.length ? hits.join('\n') : 'no secret found outside helper state');
console.log('Expected hits: only each runtime\'s own loopback keys in its own config (Hermes .env relay/API keys, openclaw.json Gateway token). Any agent API, refresh or control secret elsewhere is a stop condition.');
