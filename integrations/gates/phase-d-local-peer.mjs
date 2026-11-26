import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, owner } from '../../test/a3-harness.js';

const socket = net.createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const server = await launch({ ENVOI_INSTALLATIONS_V2: 'true', ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_A2A_GATEWAY: 'true', ENVOI_PORT: String(port), ENVOI_PUBLIC_URL: `http://127.0.0.1:${port}` });
try {
  const alice = await owner(server.baseUrl, '7901');
  const bob = await owner(server.baseUrl, '7902');
  const base = `${server.baseUrl}/api/agent/a2a/agents/${encodeURIComponent(bob.agent.address)}`;
  const child = spawn('python', [fileURLToPath(new URL('./phase-d-peer.py', import.meta.url))], {
    env: { ...process.env, PHASE_D_PEER_BASE: base, PHASE_D_PEER_TOKEN: alice.agentApiToken },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const [code] = await once(child, 'close');
  if (code !== 0) process.exitCode = code || 1;
} finally { await server.stop(); }
