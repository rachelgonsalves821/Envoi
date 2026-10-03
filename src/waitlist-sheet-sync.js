import crypto from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const HEADERS = ['email', 'joined_at', 'source'];

const sheetRange = (title, cells) => `'${title.replaceAll("'", "''")}'!${cells}`;

export function createWaitlistSheetSync({ store, sheetId, serviceAccountJson, fetchImpl = fetch }) {
  if (!store || !sheetId || !serviceAccountJson) throw new Error('Waitlist Sheet configuration is incomplete');
  const credentials = JSON.parse(serviceAccountJson);
  if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) {
    throw new Error('A Google service account is required for waitlist Sheet sync');
  }
  let token = null;
  let tokenExpiresAt = 0;
  let currentRun = null;

  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Waitlist Sheet API returned ${response.status}`);
    return response.json();
  };

  const accessToken = async () => {
    if (token && Date.now() < tokenExpiresAt) return token;
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: credentials.client_email,
      scope: SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
    const result = await request(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
    });
    if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Waitlist Sheet token response is invalid');
    token = result.access_token;
    tokenExpiresAt = Date.now() + Math.max(0, Number(result.expires_in || 3600) - 60) * 1000;
    return token;
  };

  const googleRequest = async (url, options = {}) => request(url, {
    ...options,
    headers: { authorization: `Bearer ${await accessToken()}`, ...options.headers }
  });

  const synchronize = async () => {
    const base = `${GOOGLE_SHEETS_URL}/${encodeURIComponent(sheetId)}`;
    const metadata = await googleRequest(`${base}?fields=sheets(properties(sheetId,title))`);
    const sheet = metadata.sheets?.find(item => item.properties?.sheetId === 0);
    if (!sheet?.properties?.title) throw new Error('Waitlist Sheet tab with gid=0 was not found');
    const range = sheetRange(sheet.properties.title, 'A:C');
    const valuesUrl = `${base}/values/${encodeURIComponent(range)}`;
    const existing = await googleRequest(valuesUrl);
    const rows = existing.values || [];
    if (!rows.length) {
      await googleRequest(`${base}/values/${encodeURIComponent(sheetRange(sheet.properties.title, 'A1:C1'))}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: [HEADERS] })
      });
    } else if (HEADERS.some((header, index) => rows[0][index] !== header)) {
      throw new Error('Waitlist Sheet header must be email, joined_at, source');
    }
    const known = new Set(rows.slice(1).map(row => String(row[0] || '').trim().toLowerCase()));
    const entries = await store.listJson('waitlist');
    const pending = [];
    for (const entry of entries) {
      const email = String(entry.email || '').trim().toLowerCase();
      if (!email || known.has(email)) continue;
      known.add(email);
      pending.push([email, String(entry.createdAt || ''), String(entry.source || '')]);
    }
    for (let index = 0; index < pending.length; index += 100) {
      await googleRequest(`${valuesUrl}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: pending.slice(index, index + 100) })
      });
    }
    return pending.length;
  };

  return {
    run() {
      if (!currentRun) currentRun = store.withTransaction(['waitlist-sheet-sync'], synchronize).finally(() => { currentRun = null; });
      return currentRun;
    }
  };
}
