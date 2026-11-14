import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function localServer() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-offline-compat-'));
  const dataDir = path.join(root, 'data'), clock = path.join(root, 'clock');
  await mkdir(dataDir); await writeFile(clock, '0');
  const replace = async (file, bytes) => {
    const temporary = file + '.next'; await writeFile(temporary, bytes);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); return; }
      catch (error) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await delay(25);
      }
    }
  };
  // An allowlist prevents inherited live database, provider, email, remote origin
  // or credential settings from entering the synthetic server.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir,
    ENVOI_MONAD_PERMISSIONS: 'false', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true',
    ENVOI_OFFLINE_CLOCK: clock });
  const sourceRoot = process.env.ENVOI_OFFLINE_SERVER_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
  const child = spawn(process.execPath, ['--import', new URL('./clock-boundary.mjs', import.meta.url).href, 'src/server.js'],
    { cwd: sourceRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', stdout = '', stopped = false, delta = 0;
  child.stderr.on('data', b => { stderr += b; });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LOCAL_SERVER_START_TIMEOUT: inspect synthetic server startup')), 15000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`LOCAL_SERVER_EXIT_${code}: ${stderr}`)); });
      child.stdout.on('data', b => {
        stdout += b;
        const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
    });
    assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
    const file = parts => path.join(dataDir, ...parts);
    return { baseUrl, root, stop,
      advance: async ms => { delta += ms; await replace(clock, String(delta)); },
      get: async parts => JSON.parse(await readFile(file(parts), 'utf8')),
      edit: async (parts, change) => { const value = JSON.parse(await readFile(file(parts), 'utf8')); await replace(file(parts), JSON.stringify(change(value))); }
    };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
