import crypto from 'node:crypto';
import { gatewayError, gatewayClosed } from './provider-browser-poll.js';

export const nativeGatewayLimits = Object.freeze({ runMs: 120_000, leaseSeconds: 150, minRunMs: 60_000, items: 3, actions: 6, repliesPerHour: 60, textBytes: 4096, summaryBytes: 2048 });
const fail = (status, code, fields) => { throw gatewayError(status, code, fields); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const opaque = prefix => `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
const iso = at => new Date(at).toISOString();
const clone = value => structuredClone(value);
const replyActions = ['reply', 'request_owner', 'defer'];
function bounded(value, bytes, chars = Infinity) {
  let output = '', count = 0;
  const source = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/(?:envoi|sinaloa)_(?:agent_(?:access|refresh)|reg|mcp_read|enroll)_[A-Za-z0-9_-]+/g, '[redacted]');
  for (const point of source) { if (Buffer.byteLength(output) + Buffer.byteLength(point) > bytes || count >= chars) break; output += point; count++; }
  return output;
}
function snapshot(value = {}) {
  return {
    objective: bounded(value.objective, 2000, 500), status: bounded(value.status || 'open', 100),
    participants: (value.participants || []).slice(0, 4).map(p => ({ role: p.role === 'self' ? 'self' : 'counterparty', displayName: bounded(p.displayName, 320, 80) })),
    recentEvents: (value.recentEvents || []).slice(-10).map(e => ({ at: e.at, from: ['self', 'counterparty', 'owner'].includes(e.from) ? e.from : 'counterparty',
      summary: bounded(e.summary, 2048), truncated: e.truncated === true || bounded(e.summary, 2048) !== String(e.summary ?? '') })),
    assets: (value.assets || []).slice(0, 10).map(a => ({ assetRef: opaque('a'), name: bounded(a.name, 320, 80), state: ['clean', 'pending_scan', 'quarantined'].includes(a.state) ? a.state : 'pending_scan', bytesAvailable: false })),
    // A proposal is data, never an authorization or a structural identifier from the case.
    pendingProposal: value.pendingProposal ? { summary: bounded(value.pendingProposal.summary || value.pendingProposal.text || value.pendingProposal.title, 2048) } : null
  };
}

// No HTTP proxy or second work queue: adapter methods operate on the canonical work
// records in the same transaction as this encrypted replay/budget ledger. They MUST NOT
// make external calls or open nested transactions with keys not supplied by lockKeys.
export function createProviderGatewayNative({ gateway, adapter, enabled = () => false, now = () => Date.now() }) {
  const port = gateway.nativePort;
  if (!port || !adapter) throw new TypeError('The gateway and canonical native adapter are required');
  const ledgerId = binding => `native-ledger:${binding.installationId}`;
  const rateId = binding => `native-owner-rate:${binding.ownerId}`;
  const readLedger = async binding => await port.read(ledgerId(binding)) || { runs: {}, work: {}, keys: {} };
  const emptyLedger = () => ({ runs: {}, work: {}, keys: {} });
  function compactLedger(ledger) {
    // Old work references still need minimal case/principal metadata for current
    // authorization and settled-key replay. Private packet/session/lease material
    // is useful only while that claim is outstanding and live.
    for (const [ref, work] of Object.entries(ledger.work)) {
      if (work.closed || Date.parse(work.leaseExpiresAt) <= now()) ledger.work[ref] = {
        workRef: work.workRef, workId: work.workId, caseId: work.caseId,
        runId: work.runId, generation: work.generation, closed: true
      };
    }
    // Keep an expired run tombstone until its cookie expires. Reusing its runId
    // must remain GATEWAY_RUN_EXPIRED rather than accidentally starting a new run.
    for (const [id, run] of Object.entries(ledger.runs)) {
      if (now() > run.startedAt + nativeGatewayLimits.runMs) ledger.runs[id] = { startedAt: run.startedAt, session: run.session, generation: run.generation };
    }
    return ledger;
  }
  // This callback is server-internal. Target inboxes must come from the canonical
  // case binding, never HTTP input. Audit persistence shares the outer transaction;
  // Stage1's audit context publishes only after that transaction commits.
  const auditFor = binding => (...args) => {
    const [type, data, createdAt, targetInboxId] = args;
    if (args.length > 4 || typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,199}$/.test(type)
      || data === null || typeof data !== 'object' || Array.isArray(data)
      || createdAt !== undefined && !Number.isFinite(Date.parse(createdAt))
      || targetInboxId !== undefined && (typeof targetInboxId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(targetInboxId))) throw new TypeError('Invalid canonical native audit');
    return port.audit(targetInboxId === undefined ? binding : { ...binding, inboxId: targetInboxId }, type, data, createdAt);
  };
  const permissionCheck = identity => {
    if (identity.paused) fail(409, 'AGENT_PAUSED');
    if (!['receive_agent_messages', 'send_agent_messages', 'execute_cases'].every(p => identity.permissions?.includes(p))) fail(403, 'GATEWAY_SCOPE_DENIED');
  };
  const runBudget = run => { if (now() > run.startedAt + nativeGatewayLimits.runMs) fail(409, 'GATEWAY_RUN_EXPIRED'); };
  const retry = (until, at = now()) => Math.max(1, Math.ceil((until - at) / 1000));
  const lockKeys = async (binding, operation, input) => [
    `gateway-installation:${binding.installationId}`, `gateway-native-owner:${port.digest(binding.ownerId || binding.installationId)}`,
    ...(await adapter.lockKeys(binding, operation, input) || [])
  ];
  async function release(binding, work, reason) {
    if (work && !work.closed && Date.parse(work.leaseExpiresAt) > now()) await adapter.release(binding, work, { reason, noAttempt: true, held: reason === 'paused', audit: auditFor(binding) });
    if (work) work.closed = true;
  }
  async function revokeNative(binding, reason) {
    const record = await port.read(`installation:${binding.installationId}`);
    if (!record) return;
    const ledger = await readLedger(binding);
    for (const work of Object.values(ledger.work)) await release(binding, work, reason);
    if (record.native?.scope === 'native_work') {
      record.native = { ...record.native, scope: 'read_notify', revision: record.native.revision + 1, invalidatedAt: now() };
      // A repaired native cookie keeps Stage1 read access but cannot regain work scope.
      await port.write(`installation:${binding.installationId}`, record);
    }
    await port.write(ledgerId(binding), emptyLedger());
  }
  async function rollback() {
    const index = await port.read('native-installations') || { ids: [] };
    for (const id of index.ids) {
      const record = await port.read(`installation:${id}`);
      if (!record) continue;
      await port.lock(`native:${id}`, await lockKeys(record.binding, 'rollback', {}), () => revokeNative(record.binding, 'flag_off'));
    }
  }
  async function sessionReplaced(binding) {
    const ledger = await readLedger(binding);
    for (const work of Object.values(ledger.work)) await release(binding, work, 'session_replaced');
    await port.remove(ledgerId(binding));
  }
  const sessionReplacementKeys = binding => lockKeys(binding, 'session_replaced', {});
  async function cleanupExpired() {
    const index = await port.read('native-installations') || { ids: [] };
    const absent = new Set();
    for (const id of index.ids) {
      const record = await port.read(`installation:${id}`);
      if (!record) {
        await port.lock(`native:${id}`, [`gateway-installation:${id}`], async () => {
          if (!await port.read(`installation:${id}`)) { await port.remove(`native-ledger:${id}`); absent.add(id); }
        });
        continue;
      }
      await port.lock(`native:${id}`, await lockKeys(record.binding, 'cleanup', {}), async () => {
        const ledger = await port.read(ledgerId(record.binding));
        if (!ledger) return;
        if (ledger.sessionExpiresAt && ledger.sessionExpiresAt <= now() || ledger.sessionIdleExpiresAt && ledger.sessionIdleExpiresAt <= now()) await port.remove(ledgerId(record.binding));
        else await port.write(ledgerId(record.binding), compactLedger(ledger));
      });
    }
    if (absent.size) await port.lock('native-index-cleanup', ['gateway-native-index'], async () => {
      const latest = await port.read('native-installations') || { ids: [] }, retained = [];
      for (const id of latest.ids) if (!absent.has(id) || await port.read(`installation:${id}`)) retained.push(id);
      await port.write('native-installations', { ids: retained });
    });
  }
  async function reconcileFlags() { if (!enabled()) await rollback(); await cleanupExpired(); }
  async function commitAuthority(session, work, kind, input) {
    const at = now();
    if (session.expiresAt <= at || session.lastActivity + 86_400_000 <= at) fail(401, 'GATEWAY_SESSION_EXPIRED', { reason: 'expired' });
    const installation = await port.read(`installation:${session.binding.installationId}`);
    if (!installation || installation.binding.generation !== session.binding.generation) fail(401, 'GATEWAY_SESSION_EXPIRED', { reason: 'generation_changed' });
    if (!enabled()) fail(404, 'FEATURE_DISABLED');
    if (session.nativeScope !== 'native_work' || installation.native?.scope !== 'native_work') fail(403, 'GATEWAY_SCOPE_DENIED');
    permissionCheck(await adapter.authorize(session.binding, { work, operation: kind, input, commit: true }));
  }
  async function operation(secret, csrf, kind, input, fn) {
    if (csrf === undefined) fail(403, 'GATEWAY_CSRF_INVALID');
    // Canonical refresh can own a separate replay-safe transaction. Verify the
    // current generation/CSRF/scope first, then rotate privately outside the work
    // transaction. Refresh activity never extends the cookie's idle lifetime.
    const needsRefresh = await port.authorized(secret, false, async (session, identity) => {
      const installation = await port.read(`installation:${session.binding.installationId}`);
      if (!enabled() || session.nativeScope !== 'native_work' || installation?.native?.scope !== 'native_work' || identity.paused) return false;
      return Boolean(session.rotation || Date.parse(session.binding.credentials?.expiresAt) <= now() + 60_000);
    }, csrf, true);
    if (needsRefresh) await gateway.renew(secret, csrf, {}, false);
    const result = await port.authorized(secret, true, async (session, baseIdentity) => {
      // Session, CSRF and generation have already been verified by the Stage1 port.
      if (!enabled()) { await revokeNative(session.binding, 'flag_off'); return { refused: gatewayError(404, 'FEATURE_DISABLED') }; }
      const installation = await port.read(`installation:${session.binding.installationId}`);
      if (session.nativeScope !== 'native_work' || installation?.native?.scope !== 'native_work') fail(403, 'GATEWAY_SCOPE_DENIED');
      const ledger = await readLedger(session.binding);
      if (ledger.generation && ledger.generation !== session.binding.generation) {
        for (const prior of Object.values(ledger.work)) await release(session.binding, prior, 'session_replaced');
        Object.assign(ledger, emptyLedger());
      }
      ledger.generation = session.binding.generation;
      ledger.sessionExpiresAt = session.expiresAt;
      compactLedger(ledger);
      // A claim retry contains only runId. Its outstanding work still needs the
      // same live case/counterparty checks as act before returning a replay.
      const work = input.workRef ? ledger.work[input.workRef] : kind === 'claim'
        ? Object.values(ledger.work).find(item => item.runId === input.runId && !item.closed && Date.parse(item.leaseExpiresAt) > now()) : null;
      const holdPaused = async () => {
        for (const outstanding of Object.values(ledger.work)) await release(session.binding, outstanding, 'paused');
        await port.write(ledgerId(session.binding), ledger);
        return { refused: gatewayError(409, 'AGENT_PAUSED') };
      };
      if (baseIdentity.paused) return holdPaused();
      const identity = await adapter.authorize(session.binding, { work, operation: kind, input });
      if (identity.paused) return holdPaused();
      permissionCheck(identity);
      const result = await fn(session, identity, ledger, work);
      const currentWork = result.packet?.workRef ? ledger.work[result.packet.workRef] : work;
      await commitAuthority(session, currentWork, kind, input);
      // Every adapter effect and this ledger are staged in the outer transaction.
      // An awaited projection/policy/effect must not let a 120 s run commit late.
      // A stored act replay is intentionally allowed after its old run expired.
      if (!(kind === 'act' && result.replayed) && ledger.runs[input.runId]) runBudget(ledger.runs[input.runId]);
      ledger.sessionIdleExpiresAt = now() + 86_400_000;
      await port.write(ledgerId(session.binding), compactLedger(ledger));
      return result;
    }, csrf, false, binding => lockKeys(binding, kind, input));
    if (result?.refused) throw result.refused;
    return result;
  }
  function validRunInput(input, fields, required = fields) {
    gatewayClosed(input, fields, required);
    if (!safeId(input.runId)) fail(400, 'GATEWAY_REQUEST_INVALID');
  }
  async function claim(secret, csrf, input) {
    validRunInput(input, ['runId']);
    return operation(secret, csrf, 'claim', input, async (session, _identity, ledger) => {
      const at = now(), binding = session.binding;
      let run = ledger.runs[input.runId];
      if (run) {
        if (run.session !== port.digest(secret) || run.generation !== binding.generation) fail(409, 'GATEWAY_RUN_MISMATCH');
        runBudget(run);
      }
      const active = Object.values(ledger.work).find(w => !w.closed && Date.parse(w.leaseExpiresAt) > at);
      if (active) {
        const ownerRun = ledger.runs[active.runId];
        if (active.runId === input.runId && active.generation === binding.generation) return { state: 'work', packet: clone(active.packet), retryAfterSeconds: null, replayed: true };
        if (ownerRun && at <= ownerRun.startedAt + nativeGatewayLimits.runMs) fail(409, 'GATEWAY_CHECK_ACTIVE', { retryAfterSeconds: retry(ownerRun.startedAt + nativeGatewayLimits.runMs) });
      }
      if (!run) {
        if (ledger.lastRunAt !== undefined && at - ledger.lastRunAt < nativeGatewayLimits.minRunMs) fail(429, 'RATE_LIMITED', { retryAfterSeconds: retry(ledger.lastRunAt + nativeGatewayLimits.minRunMs) });
        run = { startedAt: at, session: port.digest(secret), generation: binding.generation, items: 0, actions: 0, excluded: [] };
        ledger.runs[input.runId] = run; ledger.lastRunAt = at;
      }
      if (active) { await port.write(ledgerId(binding), ledger); return { state: 'idle', packet: null, retryAfterSeconds: retry(Date.parse(active.leaseExpiresAt)), replayed: false }; }
      if (run.items >= nativeGatewayLimits.items || run.actions >= nativeGatewayLimits.actions) return { state: 'budget_reached', packet: null, retryAfterSeconds: 1800, replayed: false };
      const claimed = await adapter.claim(binding, { runId: input.runId, leaseSeconds: 150, excludeWorkIds: run.excluded, asOf: iso(at), runDeadline: run.startedAt + nativeGatewayLimits.runMs, audit: auditFor(binding) });
      if (now() > run.startedAt + nativeGatewayLimits.runMs) fail(409, 'GATEWAY_RUN_EXPIRED');
      if (!claimed || !claimed.workId) {
        await port.write(ledgerId(binding), ledger);
        return { state: 'idle', packet: null, retryAfterSeconds: Math.max(1, claimed?.retryAfterSeconds || 1800), replayed: false };
      }
      if (!['agent_message', 'human_instruction'].includes(claimed.kind) || !Number.isFinite(Date.parse(claimed.leaseExpiresAt)) || Date.parse(claimed.leaseExpiresAt) <= at) fail(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
      const workRef = opaque('w'), packet = { workRef, caseRef: opaque('c'), runId: input.runId, kind: claimed.kind, untrusted: true,
        leaseExpiresAt: claimed.leaseExpiresAt, renewalsLeft: 1, snapshot: snapshot(claimed.snapshot), allowedActions: replyActions.slice() };
      if (Buffer.byteLength(JSON.stringify(packet)) > 64000) fail(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
      ledger.work[workRef] = { ...claimed, packet, workRef, runId: input.runId, generation: binding.generation, renewals: 0, closed: false };
      run.items++; run.excluded.push(claimed.workId);
      await port.write(ledgerId(binding), ledger);
      return { state: 'work', packet: clone(packet), retryAfterSeconds: null, replayed: false };
    });
  }
  function liveWork(ledger, work, input, binding) {
    if (!work || work.runId !== input.runId || work.generation !== binding.generation) fail(409, 'GATEWAY_RUN_MISMATCH');
    const run = ledger.runs[input.runId];
    if (!run || run.generation !== binding.generation) fail(409, 'GATEWAY_RUN_MISMATCH');
    runBudget(run);
    if (work.closed || Date.parse(work.leaseExpiresAt) <= now()) fail(409, 'LEASE_LOST');
    if (run.actions >= nativeGatewayLimits.actions) fail(429, 'RATE_LIMITED', { retryAfterSeconds: 1800 });
    return run;
  }
  async function act(secret, csrf, input) {
    validRunInput(input, ['runId', 'workRef', 'idempotencyKey', 'action', 'text'], ['runId', 'workRef', 'idempotencyKey', 'action']);
    if (typeof input.idempotencyKey !== 'string' || [...input.idempotencyKey].length < 1 || [...input.idempotencyKey].length > 80 || typeof input.workRef !== 'string' || !/^w_[a-zA-Z0-9]{12,}$/.test(input.workRef)) fail(400, 'GATEWAY_REQUEST_INVALID');
    if (!replyActions.includes(input.action)) fail(400, 'GATEWAY_ACTION_UNSUPPORTED');
    if (input.action !== 'defer' && (typeof input.text !== 'string' || !input.text.trim()) || input.action === 'defer' && input.text !== undefined) fail(400, 'GATEWAY_REQUEST_INVALID');
    if (typeof input.text === 'string' && Buffer.byteLength(input.text) > 4096) fail(400, 'GATEWAY_REQUEST_INVALID', { reason: 'text_too_long' });
    const requestDigest = crypto.createHash('sha256').update(JSON.stringify({ runId: input.runId, workRef: input.workRef, action: input.action, text: input.text ?? null })).digest('hex');
    return operation(secret, csrf, 'act', input, async (session, _identity, ledger, work) => {
      const key = port.digest(`${input.workRef}:${input.idempotencyKey}`), prior = ledger.keys[key];
      if (prior) {
        if (prior.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_CONFLICT');
        return { ...clone(prior.result), replayed: true };
      }
      const binding = session.binding, run = liveWork(ledger, work, input, binding);
      const rate = await port.read(rateId(binding)) || { replies: [] };
      rate.replies = rate.replies.filter(at => at > now() - 3_600_000);
      if (input.action === 'reply' && rate.replies.length >= nativeGatewayLimits.repliesPerHour) fail(429, 'RATE_LIMITED', { retryAfterSeconds: retry(rate.replies[0] + 3_600_000) });
      const effect = await adapter.act(binding, work, { action: input.action, text: input.text, idempotencyKey: input.idempotencyKey, requestDigest, asOf: iso(now()), runDeadline: run.startedAt + nativeGatewayLimits.runMs, audit: auditFor(binding) });
      runBudget(run);
      if (!['sent', 'owner_approval_pending', 'deferred'].includes(effect?.state) || effect.state === 'sent' && !effect.settled) fail(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
      const result = { state: effect.state, runId: input.runId, workRef: input.workRef,
        ...(effect.state === 'sent' ? { receiptRef: opaque('r') } : {}), ...(effect.state === 'owner_approval_pending' ? { requestRef: opaque('q') } : {}),
        settled: effect.state === 'sent', replayed: false };
      // 'closed' is gateway issuance state. An owner request or defer is intentionally
      // NOT canonical settlement; the adapter releases/holds its existing canonical lease.
      work.closed = true; run.actions++;
      ledger.keys[key] = { requestDigest, result, canonicalReceiptId: effect.receiptId || null, canonicalRequestId: effect.requestId || null, at: now() };
      if (effect.state === 'sent') { rate.replies.push(now()); await port.write(rateId(binding), rate); }
      await port.write(ledgerId(binding), ledger);
      return result;
    });
  }
  async function renew(secret, csrf, input) {
    validRunInput(input, ['runId', 'workRef']);
    if (typeof input.workRef !== 'string' || !/^w_[a-zA-Z0-9]{12,}$/.test(input.workRef)) fail(400, 'GATEWAY_REQUEST_INVALID');
    return operation(secret, csrf, 'renew', input, async (session, _identity, ledger, work) => {
      const run = liveWork(ledger, work, input, session.binding);
      if (work.renewals >= 1) fail(409, 'LEASE_LOST');
      const renewed = await adapter.renew(session.binding, work, { leaseSeconds: 150, asOf: iso(now()), runDeadline: run.startedAt + nativeGatewayLimits.runMs, audit: auditFor(session.binding) });
      runBudget(run);
      if (!Number.isFinite(Date.parse(renewed?.leaseExpiresAt)) || Date.parse(renewed.leaseExpiresAt) <= now()) fail(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
      work.leaseExpiresAt = renewed.leaseExpiresAt; work.packet.leaseExpiresAt = renewed.leaseExpiresAt; work.packet.renewalsLeft = 0; work.renewals++; run.actions++;
      await port.write(ledgerId(session.binding), ledger);
      return { workRef: work.workRef, leaseExpiresAt: work.leaseExpiresAt, renewalsLeft: 0 };
    });
  }
  async function updateScope(installationId, input, ownerContext) {
    gatewayClosed(input, ['scope', 'expectedRevision', 'comparisonPhrase']);
    if (input.scope !== 'native_work' || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.comparisonPhrase !== 'string') fail(400, 'GATEWAY_REQUEST_INVALID');
    if (!enabled()) fail(404, 'FEATURE_DISABLED');
    const record = await port.read(`installation:${installationId}`);
    if (!record) fail(403, 'GATEWAY_SCOPE_DENIED');
    return port.lock(`scope:${installationId}`, [...await lockKeys(record.binding, 'scope', input), `gateway-native-index`], async () => {
      const current = await port.read(`installation:${installationId}`);
      if (!current) fail(403, 'GATEWAY_SCOPE_DENIED');
      const identity = await adapter.verifyOwnerScope(current.binding, input, ownerContext);
      permissionCheck(identity);
      if (current.comparisonPhrase !== input.comparisonPhrase) fail(403, 'GATEWAY_SCOPE_DENIED');
      const native = current.native || { revision: 0, generation: 1, scope: 'read_notify' };
      if (native.revision !== input.expectedRevision) fail(409, 'GATEWAY_SCOPE_DENIED');
      const previousGeneration = native.generation;
      await revokeNative(current.binding, 'scope_changed');
      current.native = { scope: 'native_work', revision: native.revision + 1, generation: previousGeneration + 1, ownerGrantedAt: now() };
      current.binding.generation = opaque('generation');
      await port.write(`installation:${installationId}`, current);
      const index = await port.read('native-installations') || { ids: [] };
      if (!index.ids.includes(installationId)) index.ids.push(installationId);
      await port.write('native-installations', index);
      await port.audit(current.binding, 'agent.gateway_scope_changed', { scope: 'native_work', revision: current.native.revision, generation: current.native.generation });
      return { scope: 'native_work', revision: current.native.revision, generation: current.native.generation, previousGeneration,
        effectiveAt: iso(now()), requiresNewSessionCookie: true, repair: 'owner_confirmed_repair' };
    });
  }
  return { claim, act, renew, updateScope, rollback, reconcileFlags, cleanupExpired, sessionReplacementKeys, sessionReplaced };
}
