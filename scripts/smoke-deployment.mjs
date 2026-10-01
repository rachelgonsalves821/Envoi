import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function smokeDeployment(origin, expectedSha, { fetchImpl = fetch, log = console.log } = {}) {
  const target = new URL(origin || '');
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Pass the HTTPS deployment origin, without credentials, a path, query or fragment');
  }
  if (expectedSha !== undefined && !/^[a-f0-9]{40}$/i.test(expectedSha)) {
    throw new Error('Pass the full 40-hex release SHA as the optional second smoke argument');
  }
  for (const pathname of ['/health', '/ready', '/api/auth/config', '/']) {
    const response = await fetchImpl(new URL(pathname, target), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
    if (pathname === '/ready' || pathname === '/health') {
      const body = await response.json();
      if (pathname === '/ready') {
        if (body.ready !== true || body.configurationValidated !== true || body.mode !== 'production') throw new Error('Production readiness was not confirmed');
      } else if (body.service !== 'sinaloa' || body.mode !== 'production' || body.configurationValidated !== true) {
        throw new Error('Unexpected service or non-production mode');
      }
      if (expectedSha !== undefined && body.releaseSha !== expectedSha) {
        throw new Error(`${pathname} did not confirm the expected release SHA`);
      }
    } else if (pathname === '/') {
      if (!(response.headers.get('content-type') || '').includes('text/html') || !(await response.text()).includes('<script')) throw new Error('Frontend HTML bundle is missing');
    } else { await response.body?.cancel(); }
    log(`${pathname}: passed`);
  }
  log('Public read-only smoke checks passed. Human sign-in, two-agent messaging and real upload/scanning still require acceptance tests.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await smokeDeployment(process.argv[2], process.argv[3]);
}
