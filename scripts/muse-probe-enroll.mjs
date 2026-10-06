#!/usr/bin/env node
// Owner-run, one-time Muse feasibility probe. No credential is saved to disk.

function apiOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use an Envoi origin without a path or embedded credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Envoi must use HTTPS except for loopback development');
  return url.origin;
}

function hiddenInput(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Use an interactive terminal so the token can be entered privately');
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(secret);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('Canceled'));
        if (character === '\u007f' || character === '\b') { secret = secret.slice(0, -1); continue; }
        if (/^[A-Za-z0-9_-]$/.test(character) && secret.length < 256) secret += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--api-url') throw new Error('Usage: node scripts/muse-probe-enroll.mjs --api-url https://<Envoi host>');
  const origin = apiOrigin(process.argv[3]);
  console.log('Create a Muse (read-only test) identity under Envoi > Agent connections first.');
  console.log('Do not paste the enrollment token into Muse chat, a command line, or this conversation.');
  const enrollmentToken = await hiddenInput('Paste the one-use enrollment token here (input hidden), then press Enter: ');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(enrollmentToken)) throw new Error('No valid one-use enrollment token was entered');
  const response = await fetch(`${origin}/api/agent-enroll`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ runtime: 'muse', enrollmentToken })
  });
  if (!response.ok) throw new Error(`Enrollment failed (HTTP ${response.status}). Check the token and selected runtime in Agent connections.`);
  const result = await response.json();
  if (result.scope !== 'agent_probe' || typeof result.agentProbeToken !== 'string' || !result.agentProbeToken.startsWith('envoi_agent_probe_')
    || typeof result.agentProbeExpiresAt !== 'string' || !result.agent?.address || result.agentApiToken || result.agentRefreshToken) {
    throw new Error('Envoi did not return a bounded probe credential. Stop; inspect Agent connections before trying again.');
  }
  console.log(`\nEnrolled ${result.agent.address}. The credential expires at ${result.agentProbeExpiresAt}.`);
  console.log('Paste the credential below ONLY into Muse Custom Connector secure credential capture. It is shown once and cannot send or claim work.');
  console.log(result.agentProbeToken);
  console.log('Ask Muse to call GET /api/agent/work/availability using that credential.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Muse probe failed'); process.exitCode = 1; });
