const target = new URL(process.argv[2] || '');
if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/') {
  throw new Error('Pass the HTTPS deployment origin, without credentials or a path');
}
for (const pathname of ['/health', '/ready', '/api/auth/config', '/']) {
  const response = await fetch(new URL(pathname, target), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  if (pathname === '/ready') {
    const body = await response.json();
    if (body.ready !== true || body.configurationValidated !== true || body.mode !== 'production') throw new Error('Production readiness was not confirmed');
  } else if (pathname === '/health') {
    const body = await response.json();
    if (body.service !== 'sinaloa' || body.mode !== 'production' || body.configurationValidated !== true) throw new Error('Unexpected service or non-production mode');
  } else if (pathname === '/') {
    if (!(response.headers.get('content-type') || '').includes('text/html') || !(await response.text()).includes('<script')) throw new Error('Frontend HTML bundle is missing');
  } else { await response.body?.cancel(); }
  console.log(`${pathname}: passed`);
}
console.log('Public read-only smoke checks passed. Human sign-in, two-agent messaging and real upload/scanning still require acceptance tests.');
