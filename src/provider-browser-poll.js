import crypto from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const gatewayContract = Object.freeze({ id: 'provider-browser-poll', version: 1 });
export const gatewayLimits = Object.freeze({ pairing: 600_000, absolute: 7 * 86_400_000, idle: 86_400_000, recovery: 300_000, run: 120_000, cursor: 86_400_000 });
export const gatewayError = (statusCode, code, publicFields = {}) => Object.assign(new Error(code), { statusCode, code, publicFields });
const error = (status, code, fields) => { throw gatewayError(status, code, fields); };
const random = () => crypto.randomBytes(32).toString('base64url');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function gatewayClosed(value, keys, required = keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) error(400, 'GATEWAY_REQUEST_INVALID');
}
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const text = (value, bytes = 2048) => {
  let result = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/(?:envoi|sinaloa)_(?:agent_(?:access|refresh)|reg|mcp_read|enroll)_[A-Za-z0-9_-]+/g, '[redacted]');
  if (Buffer.byteLength(JSON.stringify(result)) > bytes) {
    const chars = [...result]; let low = 0, high = chars.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join(''))) <= bytes) low = mid; else high = mid - 1; }
    result = chars.slice(0, low).join('');
  }
  return result;
};

// All persistent values, including rotation/recovery state, are encrypted. The adapter owns
// canonical authentication, membership, work projection and existing registration services.
export function createProviderBrowserPoll({ store, key, enabled, adapter, now = () => Date.now() }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('Gateway encryption key must have 32 bytes');
  const digest = value => crypto.createHmac('sha256', key).update(`gateway:${value}`).digest('hex');
  const file = id => path.join('auth', 'provider-browser-poll', `${digest(id)}.json`);
  function seal(value, purpose) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  function unseal(raw, purpose) {
    try {
      const bytes = Buffer.from(raw, 'base64url'); if (bytes.length < 29) throw new Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
    } catch { error(503, 'GATEWAY_RECOVERY_REQUIRED'); }
  }
  const read = async id => { const record = await store.getJson(file(id)); return record ? unseal(record.encrypted, digest(id)) : null; };
  const write = (id, value) => store.putJson(file(id), { key: digest(id), encrypted: seal(value, digest(id)) });
  const auditContext = new AsyncLocalStorage();
  const audit = async (binding, type, data = {}) => {
    if (adapter.audit) auditContext.getStore().push(await adapter.audit(binding, type, data));
  };
  const lock = async (id, keys, operation) => {
    const events = [];
    const result = await store.withTransaction([`gateway:${digest(id)}`, ...keys], () => auditContext.run(events, operation));
    for (const event of events) adapter.publish?.(event);
    return result;
  };
  const on = () => { if (!enabled()) error(404, 'FEATURE_DISABLED'); };
  const iso = value => new Date(value).toISOString();
  const token = (value, purpose) => {
    if (typeof value !== 'string' || value.length > 512) error(400, 'GATEWAY_CURSOR_INVALID');
    let result; try { result = unseal(value, purpose); } catch { error(400, 'GATEWAY_CURSOR_INVALID'); }
    if (result.expiresAt <= now()) error(400, 'GATEWAY_CURSOR_INVALID');
    return result;
  };
  const ref = (value, purpose) => seal({ ...value, expiresAt: now() + gatewayLimits.cursor }, purpose);
  function csrf(record, supplied) {
    if (typeof supplied !== 'string' || !safeId(supplied) || digest(record.csrf) !== digest(supplied)) error(403, 'GATEWAY_CSRF_INVALID');
  }
  function pendingState(record) {
    if (!record) error(401, 'GATEWAY_SESSION_REQUIRED');
    if (record.expiresAt <= now()) error(401, 'GATEWAY_SESSION_EXPIRED');
    return record;
  }
  const pairingView = record => ({ state: record.state, operationId: record.operationId, csrf: record.csrf,
    expiresAt: iso(record.expiresAt), ...(record.registration ? { claimUrl: record.registration.claim.url,
      verificationCode: record.registration.claim.verificationCode, comparisonPhrase: record.phrase, retryAfterSeconds: 5 } : {}) });
  async function setup(secret) {
    on();
    if (secret) { const existing = await read(`pending:${secret}`); if (existing) return { secret, ...pairingView(pendingState(existing)) }; }
    const newSecret = random(), record = { state: 'new', csrf: random(), operationId: `pair_${crypto.randomBytes(16).toString('hex')}`, expiresAt: now() + gatewayLimits.pairing };
    await lock(`pending:${newSecret}`, [], () => write(`pending:${newSecret}`, record));
    return { secret: newSecret, ...pairingView(record) };
  }
  async function begin(secret, suppliedCsrf, input, context) {
    on(); gatewayClosed(input, ['requestedName', 'requestedPermissions', 'runtime']);
    if (!Array.isArray(input.requestedPermissions) || JSON.stringify(input.requestedPermissions) !== '["receive_agent_messages"]') error(400, 'GATEWAY_REQUEST_INVALID');
    const id = `pending:${secret}`;
    const plan = await lock(id, [], async () => {
      const p = pendingState(await read(id)); csrf(p, suppliedCsrf);
      if (p.registration) return { done: pairingView(p) };
      if (p.state !== 'new') error(503, 'GATEWAY_RECOVERY_REQUIRED');
      p.state = 'creating'; await write(id, p); return { p };
    });
    if (plan.done) return plan.done;
    // Persist intent BEFORE invoking a non-idempotent canonical registration. An uncertain
    // outcome never causes automatic re-registration (including after a process restart).
    let registration;
    try { registration = await adapter.createRegistration(input, context); }
    catch (cause) {
      if (cause.statusCode >= 400 && cause.statusCode < 500) await lock(id, [], async () => { const p = pendingState(await read(id)); if (!p.registration) { p.state = 'new'; await write(id, p); } });
      throw cause;
    }
    return lock(id, [], async () => {
      const p = pendingState(await read(id)); p.registration = registration; p.state = 'pending_claim';
      p.phrase = crypto.randomBytes(12).toString('hex');
      await write(`code:${registration.claim.verificationCode.replace(/-/g, '').toUpperCase()}`, { pendingId: id, expiresAt: p.expiresAt });
      await write(id, p); return pairingView(p);
    });
  }
  async function pairing(secret) {
    on(); const p = pendingState(await read(`pending:${secret}`));
    if (p.registration) {
      const status = await adapter.registrationStatus(p.registration);
      return { ...pairingView(p), ...status, comparisonPhrase: p.phrase, csrf: p.csrf, operationId: p.operationId, expiresAt: iso(p.expiresAt) };
    }
    return pairingView(p);
  }
  async function confirm(input, ownerContext) {
    on(); gatewayClosed(input, ['verificationCode', 'comparisonPhrase']);
    if (typeof input.verificationCode !== 'string' || typeof input.comparisonPhrase !== 'string') error(400, 'GATEWAY_REQUEST_INVALID');
    const index = await read(`code:${input.verificationCode.replace(/-/g, '').toUpperCase()}`);
    if (!index) error(409, 'GATEWAY_PAIRING_STATE');
    return lock(index.pendingId, [], async () => {
      const p = pendingState(await read(index.pendingId));
      if (p.phrase !== input.comparisonPhrase) error(409, 'GATEWAY_PAIRING_STATE');
      const owner = await adapter.confirmOwner(p.registration, ownerContext);
      p.confirmedOwner = owner; await write(index.pendingId, p);
      return { state: 'owner_confirmed', cadenceSeconds: 1800, scope: 'read_notify', expiresAfterDays: 7 };
    });
  }
  async function activate(secret, suppliedCsrf, input) {
    on(); gatewayClosed(input, ['operationId']);
    const id = `pending:${secret}`;
    const p = await lock(id, [], async () => {
      const current = pendingState(await read(id)); csrf(current, suppliedCsrf);
      if (input.operationId !== current.operationId || !current.confirmedOwner || !current.registration) error(409, 'GATEWAY_PAIRING_STATE');
      if (current.completed) {
        if (current.completed.recoverUntil <= now()) error(503, 'GATEWAY_RECOVERY_REQUIRED');
        return current;
      }
      if (!current.activationId) { current.activationId = `activation_${crypto.randomBytes(16).toString('hex')}`; await write(id, current); }
      return current;
    });
    // Canonical activation owns its own transaction and idempotency/replay detection.
    const binding = p.completed ? p.completed.binding : await adapter.activate(p.registration, p.activationId, p.confirmedOwner);
    const result = await lock(id, adapter.lockKeys(binding), async () => {
      const current = pendingState(await read(id));
      if (current.completed) {
        if (current.completed.recoverUntil <= now()) error(503, 'GATEWAY_RECOVERY_REQUIRED');
        return current.completed;
      }
      const existing = await read(`installation:${binding.installationId}`);
      if (existing?.rotation) error(503, 'GATEWAY_RECOVERY_REQUIRED');
      if (binding.reattaching && existing?.binding.generation !== binding.generation) error(503, 'GATEWAY_RECOVERY_REQUIRED');
      binding.generation = random();
      await write(`installation:${binding.installationId}`, { kind: 'installation', binding });
      const sessionSecret = random(), session = { binding, csrf: random(), createdAt: now(), lastActivity: now(), expiresAt: now() + gatewayLimits.absolute, ended: false };
      await write(`session:${sessionSecret}`, session);
      current.completed = { secret: sessionSecret, binding, recoverUntil: now() + gatewayLimits.recovery };
      current.state = 'connected'; await write(id, current);
      if (!binding.reattaching) await audit(binding, 'agent.gateway_pairing_created');
      await audit(binding, 'agent.gateway_session_created');
      return current.completed;
    });
    // A recoverable cookie never bypasses current canonical authorization.
    const view = await session(result.secret);
    return { secret: result.secret, ...view };
  }
  async function authorized(secret, mutate, operation, suppliedCsrf, allowRotation = false) {
    on(); const id = `session:${secret}`, initial = await read(id);
    if (!initial) error(401, 'GATEWAY_SESSION_REQUIRED');
    return lock(id, adapter.lockKeys(initial.binding), async () => {
      on(); const current = await read(id);
      if (!current || current.ended) error(401, 'GATEWAY_SESSION_REQUIRED');
      const installation = await read(`installation:${current.binding.installationId}`);
      if (!installation || installation.binding.generation !== current.binding.generation) error(401, 'GATEWAY_SESSION_REQUIRED');
      if (current.expiresAt <= now() || current.lastActivity + gatewayLimits.idle <= now()) error(401, 'GATEWAY_SESSION_EXPIRED');
      if (suppliedCsrf !== undefined) csrf(current, suppliedCsrf);
      if (current.rotation && !allowRotation) error(503, 'GATEWAY_RECOVERY_REQUIRED');
      const identity = await adapter.authorize(current.binding);
      const result = await operation(current, identity);
      if (mutate) { current.lastActivity = now(); await write(id, current); }
      return result;
    });
  }
  async function session(secret) {
    return authorized(secret, false, async (s, identity) => {
      const ledger = await read(ledgerId(s.binding)) || { cadence: 1800 };
      const graceSeconds = Math.max(120, Math.min(600, Math.ceil(ledger.cadence / 5)));
      return { state: identity.paused ? 'paused' : 'connected', csrf: s.csrf,
        agentAddress: text(identity.address, 256), permissionSummary: ['receive_agent_messages'], expiresAt: iso(s.expiresAt),
        polling: { cadenceSeconds: ledger.cadence, graceSeconds, lastSuccessfulCheckAt: ledger.lastCheck ? iso(ledger.lastCheck) : null,
          expectedNextCheckAt: ledger.lastCheck ? iso(ledger.lastCheck + ledger.cadence * 1000) : null, scheduleReportedState: 'unknown',
          checkState: identity.paused ? 'paused' : !ledger.lastCheck ? 'not_yet_checked' : now() > ledger.lastCheck + (ledger.cadence + graceSeconds) * 1000 ? 'overdue' : 'scheduled', closedAppEvidenceState: 'unverified' } };
    });
  }
  const ledgerId = binding => `ledger:${binding.installationId}`;
  const paused = identity => { if (identity.paused) error(409, 'AGENT_PAUSED'); };
  async function check(secret, suppliedCsrf, input) {
    if (suppliedCsrf === undefined) error(403, 'GATEWAY_CSRF_INVALID');
    gatewayClosed(input, ['runId', 'limit', 'cursor'], ['runId']);
    if (Object.hasOwn(input, 'cursor') && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 512)) error(400, 'GATEWAY_CURSOR_INVALID');
    if (!safeId(input.runId) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))) error(400, 'GATEWAY_REQUEST_INVALID');
    const stored = await read(`session:${secret}`);
    if (stored && (stored.rotation || Date.parse(stored.binding.credentials?.expiresAt) <= now() + 60_000)) await renew(secret, suppliedCsrf, {}, false);
    return authorized(secret, true, async (s, identity) => {
      paused(identity); const id = ledgerId(s.binding), ledger = await read(id) || { acks: {}, cadence: 1800 };
      const at = now(), sessionKey = digest(`session:${secret}`); let run = ledger.run;
      const newRun = !run || run.id !== input.runId || run.expiresAt <= at;
      if (run && run.expiresAt > at && (run.id !== input.runId || run.sessionKey !== sessionKey)) error(409, 'GATEWAY_CHECK_ACTIVE', { retryAfterSeconds: Math.ceil((run.expiresAt - at) / 1000) });
      if (newRun) {
        if (input.cursor) error(400, 'GATEWAY_CURSOR_INVALID');
        if (ledger.lastCheck && at - ledger.lastCheck < 60_000) error(429, 'RATE_LIMITED', { retryAfterSeconds: Math.ceil((60_000 - (at - ledger.lastCheck)) / 1000) });
        run = { id: input.runId, nonce: random(), sessionKey, visited: {}, expiresAt: at + gatewayLimits.run, high: await adapter.highWater(s.binding), pages: 0, issued: {} };
      }
      const scope = digest(`${s.binding.installationId}:${s.binding.generation}`);
      const cursor = input.cursor ? token(input.cursor, `cursor:${scope}`) : { after: 0, high: run.high, runId: run.id, nonce: run.nonce };
      if (cursor.runId !== run.id || cursor.high !== run.high || cursor.nonce !== run.nonce) error(400, 'GATEWAY_CURSOR_INVALID');
      const pageKey = `${cursor.after}:${input.limit || 20}`;
      if (run.pages >= 5 && !run.visited[pageKey]) error(429, 'RATE_LIMITED', { retryAfterSeconds: ledger.cadence });
      const rows = await adapter.pending(s.binding, { high: run.high, after: cursor.after });
      if (now() >= run.expiresAt) error(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
      const items = []; let after = cursor.after; let more = false, newlyIssued = false;
      for (const row of rows) {
        const logical = digest(`${row.id}:${row.version || 1}`);
        if (ledger.acks[logical]) { after = row.sequence; continue; }
        if (items.length >= (input.limit || 20)) { more = true; break; }
        const notificationRef = ref({ logical, nonce: run.nonce }, `notification:${scope}`);
        const item = { notificationRef, caseRef: ref({ caseId: row.caseId }, `case:${scope}`), workVersion: row.version || 1,
          senderAddress: text(row.senderAddress, 256), summary: text(row.summary), truncated: text(row.summary) !== String(row.summary ?? '') };
        if (Buffer.byteLength(JSON.stringify(items)) + Buffer.byteLength(JSON.stringify(item)) > 56_000) { more = true; break; }
        if (!run.issued[logical]) {
          if (run.pages >= 5) error(429, 'RATE_LIMITED', { retryAfterSeconds: ledger.cadence });
          newlyIssued = true;
        }
        items.push(item); run.issued[logical] = true; after = row.sequence;
      }
      if (newlyIssued || !run.visited[pageKey]) { run.pages += 1; run.visited[pageKey] = true; }
      ledger.run = run; if (newRun) ledger.lastCheck = at;
      const { credentials: _credentials, ...retentionBinding } = s.binding; ledger.binding = retentionBinding;
      await write(id, ledger);
      return { contract: gatewayContract, state: 'active', asOf: iso(at), runId: run.id, agentAddress: text(identity.address, 256), items,
        nextCursor: more ? ref({ after, high: run.high, runId: run.id, nonce: run.nonce }, `cursor:${scope}`) : null, retryAfterSeconds: ledger.cadence };
    }, suppliedCsrf);
  }
  async function acknowledge(secret, suppliedCsrf, input) {
    if (suppliedCsrf === undefined) error(403, 'GATEWAY_CSRF_INVALID');
    gatewayClosed(input, ['runId', 'notificationRefs']);
    if (!safeId(input.runId) || !Array.isArray(input.notificationRefs) || input.notificationRefs.length < 1 || input.notificationRefs.length > 50 || new Set(input.notificationRefs).size !== input.notificationRefs.length) error(400, 'GATEWAY_REQUEST_INVALID');
    return authorized(secret, false, async (s, identity) => {
      paused(identity); const id = ledgerId(s.binding), ledger = await read(id);
      if (!ledger?.run || ledger.run.id !== input.runId || ledger.run.expiresAt <= now() || ledger.run.sessionKey !== digest(`session:${secret}`)) error(409, 'GATEWAY_CHECK_ACTIVE');
      const scope = digest(`${s.binding.installationId}:${s.binding.generation}`);
      const refs = input.notificationRefs.map(value => token(value, `notification:${scope}`));
      if (refs.some(value => value.nonce !== ledger.run.nonce)) error(403, 'GATEWAY_SCOPE_DENIED');
      const logicals = refs.map(value => value.logical);
      if (new Set(logicals).size !== logicals.length) error(400, 'GATEWAY_REQUEST_INVALID');
      if (logicals.some(value => !ledger.run.issued[value])) error(403, 'GATEWAY_SCOPE_DENIED');
      const eligible = new Set((await adapter.pending(s.binding, { high: await adapter.highWater(s.binding), after: 0 })).map(row => digest(`${row.id}:${row.version || 1}`)));
      if (logicals.some(value => !eligible.has(value))) error(403, 'GATEWAY_SCOPE_DENIED');
      // Validate the whole batch before mutating. This records only presentation asserted by
      // the host, never canonical acknowledgement, claim, approval or processing.
      const changed = logicals.some(value => !ledger.acks[value]);
      for (const value of logicals) ledger.acks[value] ||= { at: now() };
      await write(id, ledger);
      if (changed) await audit(s.binding, 'agent.gateway_notification_acknowledged', { count: logicals.length });
      return { state: 'presentation_recorded', count: logicals.length };
    }, suppliedCsrf);
  }
  async function renew(secret, suppliedCsrf, input, touchIdle = true) {
    if (suppliedCsrf === undefined) error(403, 'GATEWAY_CSRF_INVALID');
    gatewayClosed(input, []);
    // Commit one operation identity BEFORE canonical rotation. An uncertain response is
    // recovered with the same old refresh token and operation, never a second rotation.
    const plan = await authorized(secret, false, async s => {
      if (!s.rotation) {
        s.rotation = { id: `rotation_${random()}`, startedAt: now() };
        await write(`session:${secret}`, s);
        await write(`installation:${s.binding.installationId}`, { kind: 'installation', binding: s.binding, rotation: s.rotation });
      }
      if (s.rotation.startedAt + gatewayLimits.recovery <= now()) error(503, 'GATEWAY_RECOVERY_REQUIRED');
      return { binding: s.binding, operation: s.rotation };
    }, suppliedCsrf, true);
    const successor = await adapter.renew(plan.binding, plan.operation);
    return authorized(secret, touchIdle, async s => {
      // Concurrent renewals may recover the same operation. A later operation must not
      // be overwritten by an earlier response arriving late.
      if (s.rotation && s.rotation.id !== plan.operation.id) error(503, 'GATEWAY_RECOVERY_REQUIRED');
      if (s.rotation?.id === plan.operation.id) {
        s.binding.credentials = successor;
        delete s.rotation;
        await write(`installation:${s.binding.installationId}`, { kind: 'installation', binding: s.binding });
        await write(`session:${secret}`, s);
      }
      return { state: 'connected', expiresAt: iso(s.expiresAt) };
    }, suppliedCsrf, true);
  }
  async function end(secret, suppliedCsrf, input) {
    on();
    if (suppliedCsrf === undefined) error(403, 'GATEWAY_CSRF_INVALID');
    gatewayClosed(input, []);
    const existing = await read(`session:${secret}`);
    if (existing?.ended) { csrf(existing, suppliedCsrf); return { state: 'ended' }; }
    return authorized(secret, false, async s => { s.ended = true; delete s.rotation; delete s.binding.credentials; await write(`session:${secret}`, s); await audit(s.binding, 'agent.gateway_session_ended'); return { state: 'ended' }; }, suppliedCsrf, true);
  }
  async function updatePolicy(binding, input, authorizeOwner = async () => {}) {
    on(); gatewayClosed(input, ['cadenceSeconds', 'alertDestination', 'expectedPolicyRevision']);
    if (!Number.isInteger(input.cadenceSeconds) || input.cadenceSeconds < 300 || input.cadenceSeconds > 86400 || input.alertDestination !== 'host_owner' || !Number.isInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 0) error(400, 'GATEWAY_REQUEST_INVALID');
    return lock(`policy:${binding.installationId}`, adapter.lockKeys(binding), async () => {
      await authorizeOwner();
      const id = ledgerId(binding), ledger = await read(id) || { acks: {}, cadence: 1800, revision: 0 };
      if ((ledger.revision || 0) !== input.expectedPolicyRevision) error(409, 'GATEWAY_PAIRING_STATE');
      ledger.cadence = input.cadenceSeconds; ledger.revision = (ledger.revision || 0) + 1; await write(id, ledger);
      await audit(binding, 'agent.poll_policy_changed', { cadenceSeconds: ledger.cadence });
      return { cadenceSeconds: ledger.cadence, alertDestination: 'host_owner', revision: ledger.revision };
    });
  }
  async function cleanup() {
    const records = await store.listJson(path.join('auth', 'provider-browser-poll'));
    for (const raw of records) {
      if (!/^[a-f0-9]{64}$/.test(raw.key || '')) continue;
      const observed = unseal(raw.encrypted, raw.key);
      await store.withTransaction([`gateway:${raw.key}`, ...(observed.binding ? adapter.lockKeys(observed.binding) : [])], async () => {
        const recordPath = path.join('auth', 'provider-browser-poll', `${raw.key}.json`);
        const latest = await store.getJson(recordPath); if (!latest) return;
        const value = unseal(latest.encrypted, raw.key);
        if (value.kind === 'installation') {
          try { await adapter.authorize(value.binding); }
          catch (cause) {
            if (['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED'].includes(cause.code)) { await store.deleteJson(recordPath); return; }
            if (cause.code !== 'GATEWAY_SCOPE_DENIED') throw cause;
          }
        }
        // Operational cookies are retained encrypted ONLY for the approved recovery window.
        // The session document itself never contains its raw browser cookie.
        if (value.completed && value.completed.recoverUntil <= now()) delete value.completed.secret;
        if (value.acks && value.binding) {
          // Leases, backoff, blocks and pauses are temporary visibility filters, not
          // terminal work. Only canonical terminal facts start the retention clock.
          const work = new Map((await adapter.notificationWork(value.binding)).map(row => [digest(`${row.id}:${row.version || 1}`), row]));
          for (const [logical, ack] of Object.entries(value.acks)) {
            if (!work.get(logical)?.terminal) delete ack.terminalObservedAt;
            else if (!ack.terminalObservedAt) ack.terminalObservedAt = now();
            else if (ack.terminalObservedAt + 30 * 86_400_000 <= now()) delete value.acks[logical];
          }
        }
        if (value.expiresAt && value.expiresAt <= now()) { await store.deleteJson(recordPath); return; }
        await store.putJson(recordPath, { key: raw.key, encrypted: seal(value, raw.key) });
      });
    }
  }
  // Internal adapter port only; no HTTP route returns this binding or its credentials.
  async function bindingForInstallation(installationId) {
    const value = await read(`installation:${installationId}`);
    if (!value || value.rotation) error(503, 'GATEWAY_RECOVERY_REQUIRED');
    await adapter.authorize(value.binding);
    return value.binding;
  }
  return { setup, begin, pairing, confirm, activate, session, check, acknowledge, renew, end, updatePolicy, cleanup, digest, bindingForInstallation };
}
