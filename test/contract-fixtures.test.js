import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { assertValidProtocolMessage } from '../src/protocol-v1.js';

const protocolFields = ['schemaVersion', 'messageId', 'conversationId', 'taskId', 'correlationId', 'causationId', 'from', 'to', 'intent', 'content', 'proposal', 'authority', 'artifactRefs', 'requiresAck', 'traceparent', 'signature', 'createdAt'];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const controlFrames = new Set(['ready', 'replay_required', 'replay_error', 'credential.ended']);
const requestCursor = request => {
  const query = new URL(request.path, 'http://fixture.invalid').searchParams;
  return request.headers?.['last-event-id'] || query.get('cursor') || null;
};

// a4-wake §2: stored events carry their cursor as the SSE id and rise above the resume
// cursor; control frames carry none; ready and replay_required report the right cursor.
function checkStreamFrames(fixture, label, check, validator) {
  const resume = requestCursor(fixture.request);
  let last = resume;
  for (const [index, frame] of fixture.frames.entries()) {
    const frameLabel = `${label} frame ${index}`;
    if (frame.comment) continue;
    check(validator(frame.schema), frame.data, frameLabel);
    if (controlFrames.has(frame.event)) {
      assert.equal(frame.id, undefined, `${frameLabel}: control frames carry no id`);
      const fromLatest = new URL(fixture.request.path, 'http://fixture.invalid').searchParams.get('from') === 'latest';
      if (['ready', 'replay_required'].includes(frame.event) && !fromLatest) assert.equal(frame.data.cursor, last, `${frameLabel}: reports the last cursor sent, else the resume cursor`);
      continue;
    }
    assert.equal(frame.id, frame.data.cursor, `${frameLabel}: SSE id is the cursor`);
    assert.equal(frame.event, frame.data.type, `${frameLabel}: SSE event name`);
    if (last) assert.ok(frame.id > last, `${frameLabel}: ids rise above the resume cursor and each other`);
    last = frame.id;
  }
}

// a4-wake §3: delta pages are ordered after the request cursor and report a consistent next cursor.
function checkDeltaPage(fixture, label) {
  const { events, nextCursor, hasMore } = fixture.response.body;
  let last = requestCursor(fixture.request);
  for (const event of events) {
    if (last) assert.ok(event.cursor > last, `${label}: events rise above the request cursor`);
    last = event.cursor;
  }
  assert.equal(nextCursor, last, `${label}: nextCursor is the last event cursor, else the request cursor`);
  if (hasMore) assert.ok(events.length > 0, `${label}: hasMore implies a non-empty page`);
}

// envoi-browser-names §1 and §6: the response sets and clears exactly the listed cookies, with the
// table's attributes; old names appear only as clears; requests carry old names only when marked.
function checkBrowserNames(fixture, schemas, label) {
  const table = schemas['x-browser-cookies'];
  const set = [];
  const cleared = [];
  for (const header of fixture.response.headers?.['set-cookie'] || []) {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    const [name, value] = pair.split('=');
    const row = table.find((entry) => entry.new === name || entry.old === name);
    assert.ok(row, `${label}: ${name} is in x-browser-cookies`);
    const isClear = value === '' && attributes.includes('Max-Age=0');
    (isClear ? cleared : set).push(name);
    if (!isClear) assert.ok(attributes.some((attribute) => /^Max-Age=\d+$/.test(attribute)), `${label}: ${name} has a Max-Age`);
    if (name === row.old) assert.ok(isClear, `${label}: ${name} is only ever cleared`);
    assert.ok(attributes.includes(`Path=${row.path}`), `${label}: ${name} Path`);
    assert.equal(attributes.includes('HttpOnly'), row.httpOnly, `${label}: ${name} HttpOnly`);
    assert.ok(attributes.includes(`SameSite=${row.sameSite}`), `${label}: ${name} SameSite`);
    if (row.domain === 'never') assert.ok(!attributes.some((attribute) => attribute.startsWith('Domain=')), `${label}: ${name} has no Domain`);
  }
  assert.deepEqual(set.sort(), [...fixture.cookies.set].sort(), `${label}: cookies set`);
  assert.deepEqual(cleared.sort(), [...fixture.cookies.cleared].sort(), `${label}: cookies cleared`);
  const headers = fixture.request.headers || {};
  const oldInRequest = /sinaloa/i.test(JSON.stringify(headers));
  assert.equal(oldInRequest, fixture.oldNamesInRequest === true, `${label}: old names appear in the request only when oldNamesInRequest is set`);
  // §1.3: responses that end or start a session clear every retired name.
  const sessionResponse = fixture.cookies.set.includes('envoi_session') || fixture.request.path === '/api/auth/logout';
  if (sessionResponse) for (const row of table) assert.ok(fixture.cookies.cleared.includes(row.old), `${label}: clears ${row.old}`);
  // §2: a mutation with the Envoi session sends the Envoi CSRF header.
  if (fixture.request.method !== 'GET' && /(?:^|;\s*)envoi_session=/.test(headers.cookie || '') && !fixture.oldNamesInRequest) {
    for (const header of Object.values(schemas['x-browser-headers'])) assert.ok(headers[header], `${label}: sends ${header}`);
  }
}

const presenceFields =['lastSeenAt', 'lastSuccessfulRefreshAt', 'lastWorkClaimAt', 'lastProcessedAt'];

// a5-presence §2: no timestamp is later than asOf, and lastSeenAt leads the other three.
function checkPresence(presence, asOf, label) {
  for (const field of presenceFields) {
    if (presence[field] && asOf) assert.ok(presence[field] <= asOf, `${label}: ${field} is not later than asOf`);
    if (presence[field] && field !== 'lastSeenAt') assert.ok(presence.lastSeenAt && presence.lastSeenAt >= presence[field], `${label}: lastSeenAt is not earlier than ${field}`);
  }
}

// a5-presence §4.2 and §5: re-derive seenAt, the connection state and both labels from the fixture's own fields.
function checkOwnerConnection(fixture, schemas, label) {
  assert.deepEqual(schemas['x-connection-states'].map((entry) => entry.state), schemas.definitions.connectionState.enum, `${label}: state table order`);
  assert.deepEqual(schemas['x-agent-labels'].map((entry) => entry.label), ['Revoked', 'Rejected', 'Pending', 'Paused', 'Active'], `${label}: agent label table order`);
  const agents = Array.isArray(fixture.response.body) ? fixture.response.body : [fixture.response.body];
  for (const [index, agent] of agents.entries()) {
    const agentLabel = `${label} agent ${index}`;
    const { connection } = agent;
    const revoked = agent.status === 'revoked' || agent.credentialRevoked;
    const { lastSeenAt, lastWorkClaimAt } = connection.presence;
    const resumeGrace = Boolean(agent.resumedAt) && Date.parse(connection.asOf) - Date.parse(agent.resumedAt) <= connection.recentWindowSeconds * 1000
      && (!lastWorkClaimAt || lastWorkClaimAt < agent.resumedAt);
    const seenAt = agent.paused || resumeGrace ? lastSeenAt : lastWorkClaimAt;
    assert.equal(connection.seenAt, seenAt, `${agentLabel}: seenAt is lastSeenAt while paused or in the resume grace, otherwise lastWorkClaimAt`);
    const state = revoked ? 'revoked'
      : agent.onboardingStatus === 'rejected' ? 'rejected'
        : agent.onboardingStatus !== 'approved' ? 'pending_approval'
          : connection.credentialExpiresAt === null ? 'not_connected'
            : connection.credentialExpiresAt <= connection.asOf ? 'needs_reconnect'
              : seenAt === null ? 'never_seen'
                : Date.parse(connection.asOf) - Date.parse(seenAt) <= connection.recentWindowSeconds * 1000 ? 'seen_recently'
                  : 'not_seen_recently';
    assert.equal(connection.state, state, `${agentLabel}: connection.state follows the first matching row`);
    assert.equal(fixture.client.connectionLabel, schemas['x-connection-states'].find((entry) => entry.state === state).connectionLabel, `${agentLabel}: connection label`);
    const expectedAgentLabel = revoked ? 'Revoked' : agent.onboardingStatus === 'rejected' ? 'Rejected' : agent.onboardingStatus !== 'approved' ? 'Pending' : agent.paused ? 'Paused' : 'Active';
    assert.equal(fixture.client.agentLabel, expectedAgentLabel, `${agentLabel}: agent label`);
    if (['not_connected', 'pending_approval', 'rejected'].includes(state)) assert.deepEqual(Object.values(connection.presence), [null, null, null, null], `${agentLabel}: no family, no presence`);
    if (revoked) assert.equal(connection.credentialExpiresAt, null, `${agentLabel}: a revoked family reports no expiry`);
    // A revoked agent reports status revoked even when it was paused (credentialRevoked overrides).
    if (!revoked) assert.equal(agent.paused, agent.status === 'paused', `${agentLabel}: paused mirrors the agent status`);
    checkPresence(connection.presence, connection.asOf, agentLabel);
  }
}

// An x-codes row may give lifecycle, retry and guidance per client surface (agent-registration §8).
function codeEntry(schemas, code, surface) {
  const entry = schemas['x-codes']?.[code];
  if (!entry) return undefined;
  const row = entry.bySurface ? entry.bySurface[surface] : entry;
  return row && { status: entry.status, ...row };
}

// agent-registration §2, §8: guidance may depend on the helper's own state, then on the reason.
const expectedGuidance = (entry, value, client) => client.helperState ? entry.guidanceByHelperState?.[client.helperState]
  : value.reason ? entry.guidanceByReason?.[value.reason] : entry.guidance;
// case-session §12: a row may also give retry per reason.
const expectedRetry = (entry, value) => value.reason && entry.retryByReason ? entry.retryByReason[value.reason] : entry.retry;

// agent-registration §8: an error body follows its x-codes row for status, lifecycle, retry and guidance.
function checkCodedError(response, client, schemas, label) {
  const value = response.body;
  if (!value || typeof value !== 'object' || !('code' in value)) {
    assert.ok(response.status < 400, `${label}: error responses must use the error envelope`);
    return;
  }
  const entry = codeEntry(schemas, value.code, client.surface);
  assert.ok(entry, `${label}: ${value.code} has no x-codes row for ${client.surface}`);
  assert.equal(value.error, value.code, `${label}: error must equal code`);
  assert.equal(response.status, entry.status, `${label}: HTTP status for ${value.code}`);
  assert.equal(client.lifecycle, entry.lifecycle, `${label}: lifecycle for ${value.code}`);
  assert.equal(client.retry, expectedRetry(entry, value), `${label}: retry for ${value.code}`);
  assert.equal(client.guidance, expectedGuidance(entry, value, client), `${label}: guidance for ${value.code}`);
  if (response.status === 429) assert.equal(response.headers?.['retry-after'], String(value.retryAfterSeconds), `${label}: retry-after`);
}

// agent-registration §2: codes are typed case-insensitively, without separators, and I/L/O read as 1/1/0.
const normalizeVerificationCode = (code) => {
  const symbols = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};

const sameMembers = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

// agent-registration §7: the values each response may expose to a model, by x-model-visible key.
function modelVisibleSources(response, schemas) {
  const body = response.body;
  const labels = (permissions) => permissions.map((permission) => schemas['x-permission-labels'][permission]);
  switch (response.schema) {
    case 'registrationCreated':
      return { registrationStatus: 'pending_claim', claimUrl: body.claim.url, verificationCode: body.claim.verificationCode, expiresInSeconds: schemas['x-limits'].registrationTtlSeconds };
    case 'registrationStatus':
      return { registrationStatus: body.status, workspaceName: body.workspaceName, approverEmailHint: body.approverEmailHint, agentName: body.agent?.name, agentAddress: body.agent?.address, permissionSummary: body.effectivePermissions && labels(body.effectivePermissions) };
    case 'activated':
      return { registrationStatus: 'activated', agentName: body.agent.name, agentAddress: body.agent.address, agentStatus: body.agent.status, connectionRoute: body.installation.connectionRoute, deliveryMode: body.installation.deliveryMode, permissionSummary: labels(body.effectivePermissions) };
    case 'agentStatusWithInstallation':
      return { agentAddress: body.agent.address, agentStatus: body.agent.status, connectionRoute: body.installation?.connectionRoute, deliveryMode: body.installation?.deliveryMode };
    default:
      return {};
  }
}

// agent-registration §1: which flag gates a path, and the lifecycle each successful helper response implies.
const registrationPath = /^\/api\/(?:agent-registrations|agent-claims|agent-installations\/activate)/;
const installationsPath = /^\/api\/inboxes\/[^/]+\/agents\/[^/]+\/installations/;
const successLifecycle = {
  registrationCreated: () => 'PENDING_CLAIM',
  registrationStatus: (body) => ({ pending_claim: 'PENDING_CLAIM', approved: 'CONFIRMING', activated: 'ACTIVATING' })[body.status] || 'REGISTRATION_ENDED',
  activated: () => 'ACTIVATING',
  agentStatusWithInstallation: () => 'CONNECTED',
};

// agent-registration §7: the helper state a response allows.
const errorStates = { DEGRADED: 'degraded', PENDING_CLAIM: 'pending_approval', REVOKED: 'revoked', NEEDS_RECONNECT: 'needs_reconnect', REGISTRATION_ENDED: 'registration_ended' };
function expectedStates(response, client) {
  const body = response.body;
  if (body?.code) return [errorStates[client.lifecycle] || 'needs_help'];
  switch (response.schema) {
    case 'registrationCreated': return ['pending_approval'];
    case 'registrationStatus': return { pending_claim: ['pending_approval'], approved: ['confirm_approval'], activated: ['needs_help'] }[body.status] || ['registration_ended'];
    case 'agentStatusWithInstallation': return [body.agent.status === 'paused' ? 'paused' : 'connected'];
    case 'routeAvailability': return body.routes.some((entry) => entry.available) ? [] : ['needs_help'];
    default: return [];
  }
}

// agent-registration §7: every id-like value an exchange carries. None may reach a model.
const idPattern = /^(?:registration|installation|agent|inbox|credential_family|activation)_[A-Za-z0-9_-]+$/;
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function privateValues(...values) {
  const found = new Set();
  const walk = (value, key) => {
    if (typeof value === 'string') {
      // Ids and their UUIDs only: an existing agent's address may itself be a UUID, and it is model-visible.
      for (const candidate of [value, ...value.split('/')]) {
        if (!idPattern.test(candidate) && !(candidate === value && key === 'activationId')) continue;
        found.add(candidate);
        for (const uuid of candidate.match(uuidPattern) || []) found.add(uuid);
      }
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, name);
  };
  values.forEach((value) => walk(value));
  return [...found];
}

// agent-registration §1–§6: cache headers on successful responses. Error envelopes and the a3 status route keep theirs.
const cacheControl = (schema) => schema === 'routeAvailability' ? 'public, max-age=60' : schema === 'agentStatusWithInstallation' ? undefined : 'no-store';

// agent-registration §2: which RATE_LIMITED reasons a route can return (none is the ordinary a3 limit).
function rateLimitReasons(method, pathname) {
  if (method === 'POST' && pathname === '/api/agent-registrations') return ['registration_limit', undefined];
  if (method === 'GET' && /^\/api\/agent-registrations\/[^/]+$/.test(pathname)) return ['poll_interval', undefined];
  if (/^\/api\/agent-claims(?:\/lookup)?$/.test(pathname) || /^\/api\/agent-registrations\/[^/]+\/(?:approve|reject)$/.test(pathname)) return ['claim_attempts', undefined];
  return [undefined];
}

// agent-registration §8: codes that belong to one route only.
const activatePath = (method, pathname) => method === 'POST' && pathname === '/api/agent-installations/activate';
const codeRoutes = {
  REGISTRATION_INVALID: (method, pathname) => method === 'POST' && pathname === '/api/agent-registrations',
  ROUTE_NOT_AVAILABLE: (method, pathname) => method === 'POST' && pathname === '/api/agent-registrations',
  ACTIVATION_INVALID: activatePath, ACTIVATION_ID_REQUIRED: activatePath, ACTIVATION_REPLAY: activatePath,
  DELIVERY_MODE_NOT_AVAILABLE: activatePath, REGISTRATION_PENDING: activatePath, REGISTRATION_ENDED: activatePath,
  INSTALLATION_NOT_FOUND: (method, pathname) => /^\/api\/inboxes\/[^/]+\/agents\/[^/]+\/installations\//.test(pathname)
};

// agent-registration §2: a bootstrap token authenticates only registration status and activation.
const bootstrapRoute = (method, pathname) => (method === 'GET' && /^\/api\/agent-registrations\/[^/]+$/.test(pathname)) || (method === 'POST' && pathname === '/api/agent-installations/activate');

// agent-registration v1 rules a schema cannot express. Applied to each exchange of a fixture.
function checkAgentRegistration(fixture, schemas, check, validator, label) {
  const exchanges = fixture.steps ? fixture.steps.map((step, index) => ({ ...step, label: `${label} step ${index}` }))
    : [{ request: fixture.request, response: fixture.response, client: fixture.client, label }];
  const flags = { ENVOI_AGENT_REGISTRATION_V2: true, ENVOI_INSTALLATIONS_V2: true, ENVOI_AUTHENTICATED_REST_ROUTE: false, ...fixture.flags };
  const core = flags.ENVOI_AGENT_REGISTRATION_V2 && flags.ENVOI_INSTALLATIONS_V2;
  const routeAvailable = { local_helper: core, authenticated_rest: core && flags.ENVOI_AUTHENTICATED_REST_ROUTE, remote_mcp_oauth: false, provider_connector: false };
  const modeAvailable = (mode) => core && mode === 'envoi_link';
  const visible = schemas['x-model-visible'];
  for (const { request, response, client, label: stepLabel } of exchanges) {
    const body = response.body;
    const code = body && typeof body === 'object' ? body.code : undefined;
    if (request.method === 'POST' && 'body' in request && registrationPath.test(request.path)) assert.ok(request.schema || request.invalidAgainst, `${stepLabel}: a registration-route body names its schema or invalidAgainst`);
    if (request.schema) check(validator(request.schema), request.body, `${stepLabel} request`);
    if (request.invalidAgainst) {
      const validate = validator(request.invalidAgainst);
      assert.equal(validate(request.body), false, `${stepLabel}: the negative request must fail ${request.invalidAgainst}`);
      assert.ok(request.invalidBecause, `${stepLabel}: a negative request names why it fails`);
      assert.ok(validate.errors.some((error) => error.keyword === request.invalidBecause.keyword && error.instancePath === request.invalidBecause.instancePath), `${stepLabel}: fails for ${request.invalidBecause.keyword} at "${request.invalidBecause.instancePath}"`);
    }
    if (fixture.steps) {
      check(validator(response.schema), body, `${stepLabel} response`);
      checkCodedError(response, client, schemas, stepLabel);
    }
    // §1: flags decide FEATURE_DISABLED, ROUTE_NOT_AVAILABLE and DELIVERY_MODE_NOT_AVAILABLE, and nothing else does.
    const pathname = request.path.split('?')[0];
    const gate = registrationPath.test(pathname) ? flags.ENVOI_AGENT_REGISTRATION_V2 : installationsPath.test(pathname) ? flags.ENVOI_INSTALLATIONS_V2 : true;
    assert.equal(code === 'FEATURE_DISABLED', !gate, `${stepLabel}: FEATURE_DISABLED exactly when the route's flag is off`);
    if (request.auth === 'bootstrap' && gate && !bootstrapRoute(request.method, pathname)) {
      assert.equal(code, 'AUTHENTICATION_REQUIRED', `${stepLabel}: a bootstrap token elsewhere is an unrecognized bearer (§2)`);
    }
    if (codeRoutes[code]) assert.ok(codeRoutes[code](request.method, pathname), `${stepLabel}: ${code} belongs to another route than ${request.method} ${pathname}`);
    if (code === 'RATE_LIMITED') assert.ok(rateLimitReasons(request.method, pathname).includes(body.reason), `${stepLabel}: RATE_LIMITED reason ${body.reason} fits ${request.method} ${pathname}`);
    if (!code && response.status < 300) assert.equal(response.headers?.['cache-control'], cacheControl(response.schema), `${stepLabel}: cache-control for ${response.schema}`);
    if (gate && request.method === 'POST' && pathname === '/api/agent-registrations' && request.schema) {
      assert.equal(code === 'ROUTE_NOT_AVAILABLE', !routeAvailable[request.body.connectionRoute], `${stepLabel}: ROUTE_NOT_AVAILABLE exactly when the route is unavailable`);
    }
    if (gate && pathname === '/api/agent-installations/activate' && request.schema) {
      assert.equal(code === 'DELIVERY_MODE_NOT_AVAILABLE', !modeAvailable(request.body.deliveryMode), `${stepLabel}: DELIVERY_MODE_NOT_AVAILABLE exactly when the mode is unavailable`);
    }
    if (!code && client.surface === 'helper' && successLifecycle[response.schema]) {
      assert.equal(client.lifecycle, successLifecycle[response.schema](body), `${stepLabel}: lifecycle for a ${response.schema} response`);
    }
    // §7: model-visible keys are allowlisted and server-derived values equal their source.
    if (client.modelVisible) {
      const sources = modelVisibleSources(response, schemas);
      for (const [key, value] of Object.entries(client.modelVisible)) {
        if (key in visible.serverDerived) {
          const expected = key === 'guidance' ? client.guidance : sources[key];
          assert.notEqual(expected, undefined, `${stepLabel}: ${key} has no source in a ${response.schema} response`);
          assert.deepEqual(value, expected, `${stepLabel}: model-visible ${key} equals its source`);
        } else {
          const rule = visible.helperDerived[key];
          assert.ok(rule, `${stepLabel}: ${key} is not model-visible`);
          if (rule.enum) assert.ok(rule.enum.includes(value), `${stepLabel}: ${key} value ${value}`);
          if (rule.pattern) assert.match(value, new RegExp(rule.pattern), `${stepLabel}: ${key} format`);
          if (rule.maxLength) assert.ok(value.length <= rule.maxLength, `${stepLabel}: ${key} length`);
        }
      }
      const pending = response.schema === 'registrationCreated' || body.status === 'pending_claim';
      const shown = JSON.stringify(client.modelVisible);
      if (!pending) assert.doesNotMatch(shown, /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/, `${stepLabel}: the code is shown only while pending`);
      assert.doesNotMatch(shown, /envoi_(?:agent_|mcp_read_|enroll_|reg_)|PLACEHOLDER/, `${stepLabel}: model-visible values carry no token`);
      assert.doesNotMatch(shown, /\b(?:registration|installation|inbox|agent|credential_family|activation)_(?!ended\b)[A-Za-z0-9-]+/, `${stepLabel}: model-visible values carry no internal id`);
      for (const value of privateValues(request.path, request.body, body, fixture.stored)) assert.ok(!shown.includes(value), `${stepLabel}: model-visible values never include ${value}`);
      if ('state' in client.modelVisible) assert.ok(expectedStates(response, client).includes(client.modelVisible.state), `${stepLabel}: state ${client.modelVisible.state} fits the response`);
    }
    if (response.schema === 'routeAvailability') {
      assert.equal(body.registrationEnabled, flags.ENVOI_AGENT_REGISTRATION_V2, `${stepLabel}: registrationEnabled`);
      assert.equal(body.installationsEnabled, flags.ENVOI_INSTALLATIONS_V2, `${stepLabel}: installationsEnabled`);
      assert.deepEqual(body.routes.map((entry) => entry.connectionRoute), schemas.definitions.connectionRoute.enum, `${stepLabel}: every route once, in order`);
      assert.deepEqual(body.deliveryModes.map((entry) => entry.deliveryMode), schemas.definitions.deliveryMode.enum, `${stepLabel}: every delivery mode once, in order`);
      for (const entry of body.routes) assert.equal(entry.available, routeAvailable[entry.connectionRoute], `${stepLabel}: ${entry.connectionRoute} availability`);
      for (const entry of body.deliveryModes) assert.equal(entry.available, modeAvailable(entry.deliveryMode), `${stepLabel}: ${entry.deliveryMode} availability`);
    }
    if (response.schema === 'registrationCreated') assert.equal(body.claim.expiresAt, body.expiresAt, `${stepLabel}: the claim expires with the registration`);
    if (response.schema === 'claimLookup') {
      assert.equal(body.verificationCode, normalizeVerificationCode(request.body.verificationCode), `${stepLabel}: the code is normalized`);
      const maximum = schemas.definitions.permission.enum;
      assert.ok(sameMembers(body.grantablePermissions, body.requestedPermissions.filter((permission) => maximum.includes(permission))), `${stepLabel}: grantable is requested ∩ organization maximum`);
    }
    // §5.3: effective = requested ∩ granted ∩ organization maximum, plus receive, for both targets.
    if (response.schema === 'claimApproved') {
      assert.equal(body.target, request.body.target.kind, `${stepLabel}: response target matches the request`);
      assert.ok(fixture.context?.requestedPermissions, `${stepLabel}: an approval names the requested permissions in context`);
      const maximum = schemas.definitions.permission.enum;
      const expected = request.body.grantedPermissions.filter((permission) => fixture.context.requestedPermissions.includes(permission) && maximum.includes(permission));
      if (!expected.includes('receive_agent_messages')) expected.push('receive_agent_messages');
      assert.ok(sameMembers(body.effectivePermissions, expected), `${stepLabel}: requested ∩ granted ∩ organization maximum, plus receive`);
      assert.equal('id' in body.agent, body.target === 'existing_agent', `${stepLabel}: only an existing agent has an id before activation`);
      if (body.target === 'existing_agent') assert.equal(body.agent.id, request.body.target.agentId, `${stepLabel}: the approved agent is the requested one`);
      if (body.target === 'new_agent') {
        assert.equal(body.agent.name, request.body.target.name, `${stepLabel}: the new agent has the chosen name`);
        if (request.body.target.localPart) assert.equal(body.agent.address.split('@')[0], request.body.target.localPart, `${stepLabel}: the new agent has the chosen address`);
      }
    }
    // §6.5: every active installation (legacy data may hold several), newest first, then at most five ended, newest first.
    if (response.schema === 'ownerInstallationList') {
      const list = body.installations;
      const active = list.filter((installation) => installation.status === 'active');
      assert.ok(active.filter((installation) => !installation.legacy).length <= 1, `${stepLabel}: v1 creates at most one active installation`);
      assert.ok(list.every((installation, index) => installation.status === 'active' || list.slice(index).every((later) => later.status === 'ended')), `${stepLabel}: active installations come first`);
      assert.ok(active.every((installation, index) => index === 0 || active[index - 1].activatedAt >= installation.activatedAt), `${stepLabel}: active installations newest first`);
      const endedList = list.filter((installation) => installation.status === 'ended');
      assert.ok(endedList.length <= schemas['x-limits'].ownerInstallationEndedMax, `${stepLabel}: at most five ended installations`);
      assert.ok(endedList.every((installation, index) => index === 0 || endedList[index - 1].endedAt >= installation.endedAt), `${stepLabel}: ended installations newest first`);
      assert.ok(list.every((installation) => installation.agentId === body.agentId), `${stepLabel}: every installation belongs to the listed agent`);
    }
    if (response.schema === 'installationRevoked') {
      assert.deepEqual([body.installation.status, body.installation.endedReason], ['ended', 'revoked'], `${stepLabel}: a revoked installation is ended/revoked`);
    }
    // §6.1: activation creates an installation on the request's delivery mode and an available route.
    if (response.schema === 'activated') {
      assert.equal(body.installation.deliveryMode, request.body.deliveryMode, `${stepLabel}: the installation has the declared delivery mode`);
      assert.ok(routeAvailable[body.installation.connectionRoute], `${stepLabel}: the installation's route is available`);
      assert.equal(body.installation.agentId, body.agent.id, `${stepLabel}: the installation belongs to the activated agent`);
    }
    // §5.4: newest first.
    if (response.schema === 'ownerClaimList') {
      assert.ok(body.claims.every((claim, index) => index === 0 || body.claims[index - 1].approvedAt >= claim.approvedAt), `${stepLabel}: claims newest first`);
    }
    if (response.schema === 'agentStatusWithInstallation') {
      checkPresence(body.presence, body.asOf, stepLabel);
      assert.equal('installation' in body, flags.ENVOI_INSTALLATIONS_V2, `${stepLabel}: installation appears exactly when ENVOI_INSTALLATIONS_V2 is on`);
    }
  }
  if (fixture.stored) checkInstallationDerivation(fixture, schemas, label);
  // §6.5, §12: after a restart, every step of a restart fixture still succeeds (nothing was frozen).
  if (fixture.kind === 'restart') checkRestart(fixture, exchanges, label);
}

// agent-registration §6.5, §12: after a restart nothing was frozen. Every step succeeds, the stored agent is
// live and approved, and an existing_agent approval attaches to it, replacing its newest active installation.
function checkRestart(fixture, exchanges, label) {
  for (const step of exchanges) assert.ok(step.response.status < 300, `${step.label}: succeeds after the restart`);
  const approvals = exchanges.filter((step) => step.response.schema === 'claimApproved' && step.request.body.target.kind === 'existing_agent');
  assert.ok(approvals.length, `${label}: a restart fixture re-attaches an existing agent`);
  for (const step of approvals) {
    const { agentId, replacesInstallationId } = step.request.body.target;
    const agent = fixture.stored.agents.find((entry) => entry.id === agentId);
    assert.ok(agent && agent.onboardingStatus === 'approved' && ['active', 'paused'].includes(agent.status), `${step.label}: the stored agent is approved and not frozen`);
    const active = fixture.stored.credentialFamilies.filter((family) => family.agentId === agentId && !family.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const newest = active[0] ? (active[0].installationId || `installation_legacy_${active[0].id.replace(/^credential_family_/, '')}`) : null;
    assert.equal(replacesInstallationId, newest, `${step.label}: replacesInstallationId is the newest active installation, or null`);
  }
}

// agent-registration §6.4 and §9: every listed installation is derived from the stored families.
function checkInstallationDerivation(fixture, schemas, label) {
  const { agents = [], credentialFamilies = [], installations: storedInstallations = [] } = fixture.stored;
  const derived = [];
  for (const family of credentialFamilies) {
    const agent = agents.find((entry) => entry.id === family.agentId);
    assert.ok(agent, `${label}: family ${family.id} has a stored agent`);
    // Only the legacy projection is limited to approved and frozen agents; stored installations are always listed.
    if (!family.installationId && !['approved', 'revoked'].includes(agent.onboardingStatus)) continue;
    derived.push({ family, agent });
  }
  const steps = fixture.steps.filter((entry) => ['ownerInstallationList', 'agentStatusWithInstallation'].includes(entry.response.schema));
  for (const step of steps) {
    const expected = [];
    for (const { family, agent } of derived) {
      const ended = Boolean(family.revokedAt);
      const stored = family.installationId && storedInstallations.find((entry) => entry.id === family.installationId);
      if (family.installationId) assert.ok(stored, `${label}: family ${family.id} names a stored installation`);
      expected.push(stored
        ? { ...Object.fromEntries(Object.entries(stored).filter(([key]) => !['credentialFamilyId', 'registrationId', 'replayDetectedAt'].includes(key))), status: ended ? 'ended' : 'active', endedReason: ended ? (stored.replayDetectedAt ? 'activation_replay' : family.revokedReason || 'revoked') : null, endedAt: family.revokedAt, legacy: false }
        : { id: `installation_legacy_${family.id.replace(/^credential_family_/, '')}`, agentId: family.agentId, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', runtime: { type: family.runtime || agent.runtime || 'unknown', version: null }, status: ended ? 'ended' : 'active', endedReason: ended ? family.revokedReason || 'revoked' : null, legacy: true, createdAt: family.createdAt, activatedAt: family.createdAt, endedAt: family.revokedAt });
    }
    const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    if (step.response.schema === 'ownerInstallationList') {
      const listed = expected.filter((entry) => entry.agentId === step.response.body.agentId);
      const shown = [...listed.filter((entry) => entry.status === 'active'),
        ...listed.filter((entry) => entry.status === 'ended').sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, schemas['x-limits'].ownerInstallationEndedMax)];
      assert.deepEqual(byId(step.response.body.installations), byId(shown), `${label}: installations are derived from the stored families (x-legacy-projection, x-installation-derivation)`);
    } else if (step.response.body.installation) {
      const { installation } = step.response.body;
      const match = expected.find((entry) => entry.id === installation.id);
      assert.ok(match && match.status === 'active', `${label}: agent status names an active derived installation`);
      assert.deepEqual(installation, { id: match.id, connectionRoute: match.connectionRoute, deliveryMode: match.deliveryMode, legacy: match.legacy }, `${label}: agent status installation summary`);
    }
  }
}

// http-wake §4.2: x-blocked-ranges as one list per family, and IPv6 only inside x-ipv6-global-unicast. A single list
// would match every IPv4 address against ::ffff:0:0/96.
function wakeBlockedCheck(schemas) {
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const { cidr } of schemas['x-blocked-ranges']) {
    const [address, prefix] = cidr.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    lists[family].addSubnet(address, Number(prefix), family);
  }
  const global = new BlockList();
  const [globalAddress, globalPrefix] = schemas['x-ipv6-global-unicast'].split('/');
  global.addSubnet(globalAddress, Number(globalPrefix), 'ipv6');
  return (address) => {
    if (isIP(address) === 4) return lists.ipv4.check(address, 'ipv4');
    if (isIP(address) === 6) return !global.check(address, 'ipv6') || lists.ipv6.check(address, 'ipv6');
    return true;
  };
}

// http-wake §4.1–§4.2: the first rule a URL breaks, in x-url-checks order, or null. Without dns only the rules that
// need no lookup apply. selfHosts are ENVOI_WAKE_SELF_HOSTS entries in force besides x-self-hosts-example.
function wakeUrlRejection(raw, dns, schemas, selfHosts = []) {
  const limits = schemas['x-limits'];
  if (raw.length > limits.urlMaxLength) return 'url_too_long';
  let url;
  try { url = new URL(raw); } catch { return 'url_invalid'; }
  if (url.href.length > limits.urlMaxLength) return 'url_too_long';
  if (url.protocol !== 'https:') return 'scheme_not_https';
  if (url.username || url.password) return 'userinfo_present';
  if (url.port && !limits.allowedPorts.includes(Number(url.port))) return 'port_not_allowed';
  if (raw.includes('?')) return 'query_present';
  if (raw.includes('#')) return 'fragment_present';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return 'address_literal';
  const self = [new URL(schemas['x-public-origin-example']).hostname, ...schemas['x-self-hosts-example'], ...selfHosts];
  if (self.some((name) => hostname === name || hostname.endsWith(`.${name}`))) return 'self_target';
  if (hostname.endsWith('.') || !hostname.includes('.') || schemas['x-reserved-names'].some((name) => hostname === name || hostname.endsWith(`.${name}`))) return 'reserved_name';
  if (!dns) return null;
  if (dns.error || dns.addresses.length === 0 || dns.addresses.some(wakeBlockedCheck(schemas))) return 'address_not_allowed';
  return null;
}

// http-wake §5.1: the bytes a notification signature covers, and the single v1 entry of the signature header.
const wakeSigningBytes = (request, url) => {
  const headers = request.headers;
  return Buffer.concat([Buffer.from(`envoi-wake/1\n${headers['envoi-wake-key-id']}\n${headers['envoi-wake-timestamp']}\n${headers['envoi-wake-id']}\n${url}\n`, 'utf8'), Buffer.from(request.bodyText, 'utf8')]);
};
function wakeSignatureEntry(request) {
  const entries = String(request.headers['envoi-wake-signature'] || '').split(' ').filter((entry) => entry.startsWith('v1='));
  return entries.length === 1 && /^v1=[A-Za-z0-9_-]{86}$/.test(entries[0]) ? entries[0] : undefined;
}
function wakeSignatureValid(request, url, key) {
  const entry = wakeSignatureEntry(request);
  if (!entry) return false;
  const publicKey = crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: 'jwk' });
  return crypto.verify(null, wakeSigningBytes(request, url), publicKey, Buffer.from(entry.slice(3), 'base64url'));
}

// http-wake §7.1: what a receiver concludes from a request, following x-receiver-checks in order.
function wakeReceiverVerdict(request, receiver, schemas, validator) {
  const limits = schemas['x-limits'];
  const headers = request.headers;
  const result = (verdict, reason = null, body) => ({ verdict, reason, body });
  const wellFormed = request.method === 'POST' && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')
    && Buffer.byteLength(request.bodyText, 'utf8') <= limits.requestBodyMaxBytes
    && /^wake_evt_[A-Za-z0-9_-]{16,64}$/.test(headers['envoi-wake-id'] || '') && /^[1-9][0-9]{0,11}$/.test(headers['envoi-wake-timestamp'] || '')
    && /^[A-Za-z0-9._-]{1,64}$/.test(headers['envoi-wake-key-id'] || '') && Boolean(wakeSignatureEntry(request));
  if (!wellFormed) return result('reject', 'malformed');
  const key = receiver.jwks.keys.find((entry) => entry.kid === headers['envoi-wake-key-id']);
  if (!key) return result('defer', 'unknown_key');
  if (key.notAfter && Date.parse(key.notAfter) <= Date.parse(receiver.clock)) return result('reject', 'key_expired');
  if (Math.abs(Date.parse(receiver.clock) / 1000 - Number(headers['envoi-wake-timestamp'])) > limits.timestampToleranceSeconds) return result('reject', 'timestamp_out_of_window');
  if (!wakeSignatureValid(request, receiver.registeredUrl, key)) return result('reject', 'signature_invalid');
  let body;
  try { body = JSON.parse(request.bodyText); } catch { return result('reject', 'not_a_notification'); }
  if (!validator('notificationEnvelope')(body) || body.id !== headers['envoi-wake-id']) return result('reject', 'not_a_notification');
  if (!receiver.subscriptionIds.includes(body.subscriptionId)) return body.type === 'wake.challenge' ? result('defer', 'challenge_for_unknown_subscription', body) : result('reject', 'subscription_unknown', body);
  if (receiver.seenIds.includes(body.id)) return result('duplicate', null, body);
  return result('process', null, body);
}

// http-wake §6.2: how the server classifies an attempt from its response, or from where it stopped without one.
function wakeFailureClass(delivery, limits) {
  if (!delivery.response) {
    const { phase, elapsedMs } = delivery.transport;
    if (phase === 'interrupted') return 'interrupted';
    if (phase === 'connect') return elapsedMs >= limits.connectTimeoutMs ? 'timeout' : 'connect_failed';
    if (phase === 'tls') return elapsedMs >= limits.deliveryTimeoutMs ? 'timeout' : 'tls_failed';
    return elapsedMs >= limits.deliveryTimeoutMs ? 'timeout' : 'unclassified';
  }
  const { status } = delivery.response;
  if (status >= 200 && status < 300) return null;
  if (status === 410) return 'receiver_gone';
  if (status >= 300 && status < 400) return 'redirect_rejected';
  if ([408, 425, 429].includes(status) || status >= 500) return 'http_retryable';
  return 'http_rejected';
}

const wakeHostRoute = /^\/api\/agent\/wake-subscriptions(?:\/[^/]+\/(?:activate|end))?$/;
const wakeOwnerRoute = /^\/api\/inboxes\/[^/]+\/agents\/[^/]+\/wake-subscriptions(?:\/[^/]+\/revoke)?$/;
const wakeKeysRoute = '/.well-known/envoi-wake-keys.json';
const wakeEntityPrefix = /(?<![A-Za-z0-9])(?:case|msg|agent|inbox|installation|credential_family|case_session|human|asset|lease|registration|work)_[A-Za-z0-9]/;
const privateWakeContent = new RegExp(`${wakeEntityPrefix.source}|@|envoi_(?:agent_|mcp_read_|case_session_|reg_)|"text"|https?:`);
const caseSessionSchema = (name) => typeof name === 'string' && name.startsWith('case-session#');
const wakeBearerPrefix = { agent_access: 'Bearer envoi_agent_access_', case_session: 'Bearer envoi_case_session_', mcp_read: 'Bearer envoi_mcp_read_', bootstrap: 'Bearer envoi_reg_' };

// http-wake §2.2, §3, §9: one subscription object is internally consistent.
function checkWakeSubscription(subscription, schemas, label) {
  const limits = schemas['x-limits'];
  const { status, delivery } = subscription;
  const seconds = (value) => Date.parse(value) / 1000;
  assert.equal(wakeUrlRejection(subscription.url, undefined, schemas), null, `${label}: a stored url passes the rules that need no lookup`);
  assert.equal(new URL(subscription.url).href, subscription.url, `${label}: the url is stored in canonical form`);
  assert.equal(status === 'ended', subscription.endedReason !== null && subscription.endedAt !== null, `${label}: ended exactly when endedReason and endedAt are set`);
  assert.equal(status === 'pending', subscription.challengeExpiresAt !== null, `${label}: only a pending subscription has a challenge deadline`);
  assert.notEqual(subscription.replacesSubscriptionId, subscription.id, `${label}: a subscription never replaces itself`);
  assert.equal(subscription.expiresAt, subscription.activatedAt && new Date(Date.parse(subscription.activatedAt) + limits.subscriptionLifetimeDays * 86400000).toISOString(), `${label}: expiresAt is activatedAt + subscriptionLifetimeDays`);
  if (subscription.activatedAt) assert.ok(seconds(subscription.activatedAt) - seconds(subscription.createdAt) <= limits.challengeTtlSeconds && subscription.activatedAt >= subscription.createdAt, `${label}: activated within the challenge window`);
  if (subscription.endedAt) assert.ok(subscription.endedAt >= subscription.createdAt, `${label}: ended after it was created`);
  if (status === 'pending') {
    assert.equal(subscription.activatedAt, null, `${label}: pending is not activated`);
    assert.equal(seconds(subscription.challengeExpiresAt) - seconds(subscription.createdAt), limits.challengeTtlSeconds, `${label}: challengeExpiresAt is createdAt + challengeTtlSeconds`);
  }
  // §9: a subscription that never activated never reports how its challenge fared.
  if (subscription.activatedAt === null) assert.deepEqual(delivery, { state: 'unverified', lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailureClass: null }, `${label}: no delivery detail before activation`);
  const activated = schemas['x-ended-reasons'][subscription.endedReason]?.activated;
  if (activated !== undefined && activated !== null) assert.equal(subscription.activatedAt !== null, activated, `${label}: ${subscription.endedReason} ${activated ? 'follows' : 'precedes'} activation`);
  if (subscription.endedReason === 'expired') assert.equal(subscription.endedAt, subscription.expiresAt, `${label}: expired at expiresAt`);
  if (subscription.endedReason === 'challenge_expired') assert.equal(seconds(subscription.endedAt) - seconds(subscription.createdAt), limits.challengeTtlSeconds, `${label}: challenge_expired at the end of the window`);
  if (status === 'ended' && delivery.lastAttemptAt) assert.ok(delivery.lastAttemptAt <= subscription.endedAt, `${label}: no attempt after the end`);
  assert.equal(delivery.state === 'failing', delivery.consecutiveFailures > 0, `${label}: failing exactly when a notification failed last`);
  assert.equal(delivery.state === 'unverified', delivery.lastSuccessAt === null && delivery.consecutiveFailures === 0, `${label}: unverified until a first acknowledgement`);
  assert.equal(delivery.lastFailureClass !== null, delivery.consecutiveFailures > 0, `${label}: a failure class only while failing`);
  if (delivery.lastSuccessAt) assert.ok(delivery.lastAttemptAt >= delivery.lastSuccessAt, `${label}: the last attempt is not earlier than the last success`);
  if (subscription.endedReason === 'delivery_failed') {
    assert.ok(delivery.consecutiveFailures >= limits.endAfterFailedDeliveries, `${label}: delivery_failed needs endAfterFailedDeliveries failures`);
    assert.ok(seconds(subscription.endedAt) - seconds(delivery.lastSuccessAt ?? subscription.activatedAt) >= limits.endAfterFailingSeconds, `${label}: delivery_failed needs endAfterFailingSeconds without an acknowledgement`);
  }
  if (subscription.endedReason === 'receiver_gone') assert.equal(delivery.lastFailureClass, 'receiver_gone', `${label}: receiver_gone follows a 410`);
}

// http-wake §3.6, §3.7: pending, then active, then at most the cap of ended ones, newest first; per installation at
// most one pending and one active; a replaced subscription ended when its listed successor activated.
function checkWakeList(subscriptions, max, label) {
  const rank = { pending: 0, active: 1, ended: 2 };
  assert.ok(subscriptions.every((entry, index) => index === 0 || rank[subscriptions[index - 1].status] <= rank[entry.status]), `${label}: pending, then active, then ended`);
  const endedList = subscriptions.filter((entry) => entry.status === 'ended');
  assert.ok(endedList.length <= max, `${label}: at most ${max} ended`);
  assert.ok(endedList.every((entry, index) => index === 0 || endedList[index - 1].endedAt >= entry.endedAt), `${label}: ended newest first`);
  for (const live of ['pending', 'active']) {
    const installations = subscriptions.filter((entry) => entry.status === live).map((entry) => entry.installationId);
    assert.equal(new Set(installations).size, installations.length, `${label}: at most one ${live} subscription per installation`);
  }
  for (const entry of subscriptions.filter((item) => item.replacesSubscriptionId)) {
    const replaced = subscriptions.find((item) => item.id === entry.replacesSubscriptionId);
    if (replaced) assert.equal(replaced.installationId, entry.installationId, `${label}: a replacement belongs to the same installation`);
  }
}

// http-wake v1 rules for one delivery step: server checks (§4, §6, §8) and receiver checks (§7).
function checkWakeDelivery(step, fixture, schemas, check, validator, label) {
  const { delivery, receiver } = step;
  const context = step.context || fixture.context || {};
  const flags = { ENVOI_HTTP_WAKE_V1: true, ...fixture.flags };
  const limits = schemas['x-limits'];
  if (delivery.origin === 'server') {
    const subscription = context.subscription;
    const credential = context.credential || 'valid';
    assert.ok(subscription, `${label}: a server delivery names its subscription`);
    // §8: nothing is attempted with the flag off, for an ended subscription or installation, or with an expired
    // credential; a pending subscription gets only its challenge; a paused agent gets no work notification.
    const blockedBy = !flags.ENVOI_HTTP_WAKE_V1 ? 'feature_disabled' : (credential === 'ended' || subscription.status === 'ended') ? 'subscription_ended'
      : credential === 'expired' ? 'credential_expired' : undefined;
    if (delivery.outcome === 'not_sent') {
      const expected = blockedBy || (subscription.status === 'pending' ? 'subscription_pending' : context.agentStatus === 'paused' ? 'agent_paused' : undefined);
      assert.equal(delivery.notSentReason, expected, `${label}: the reason nothing was sent follows the state (§8)`);
      if (expected === 'agent_paused') assert.equal(delivery.suppressed.type, 'wake.work_available', `${label}: only work notifications are withheld while paused`);
      return;
    }
    assert.equal(blockedBy, undefined, `${label}: nothing is attempted in this state`);
    const isChallenge = subscription.status === 'pending';
    // §4: the URL rules run again before every attempt, before any lookup.
    const urlRule = wakeUrlRejection(subscription.url, undefined, schemas, context.selfHosts);
    assert.equal(delivery.failureClass === 'url_rejected', urlRule !== null, `${label}: url_rejected exactly when the stored URL now breaks a rule`);
    if (urlRule) {
      assert.deepEqual([delivery.sent, delivery.outcome], [false, 'failed'], `${label}: a refused URL gets nothing and is not retried`);
      return;
    }
    // §4.2: every attempt resolves once and checks every address.
    const blocked = wakeBlockedCheck(schemas);
    const addressRejected = Boolean(delivery.dns.error) || delivery.dns.addresses.length === 0 || delivery.dns.addresses.some(blocked);
    assert.equal(delivery.failureClass === 'address_rejected', addressRejected, `${label}: address_rejected exactly when the resolution failed, was empty, or has a blocked address`);
    assert.equal(delivery.dns.host, new URL(subscription.url).hostname, `${label}: the subscription host is resolved`);
    assert.equal(delivery.sent, !addressRejected, `${label}: a rejected resolution sends nothing`);
    let body;
    let ts;
    if (delivery.sent) {
      // §4.3: connect only to a checked address of that same resolution, verifying TLS for the URL host.
      assert.ok(delivery.dns.addresses.includes(delivery.connect.address), `${label}: the connection uses an address from the checked resolution`);
      assert.ok(limits.allowedPorts.includes(delivery.connect.port), `${label}: port`);
      assert.equal(delivery.connect.servername, new URL(subscription.url).hostname, `${label}: SNI and certificate name are the URL host`);
      assert.equal(delivery.request.url, subscription.url, `${label}: sent to the registered url`);
      assert.equal(delivery.request.method, 'POST', `${label}: POST`);
      check(validator('deliveryHeaders'), delivery.request.headers, `${label} headers`);
      assert.ok(Buffer.byteLength(delivery.request.bodyText, 'utf8') <= limits.requestBodyMaxBytes, `${label}: body within requestBodyMaxBytes`);
      body = JSON.parse(delivery.request.bodyText);
      check(validator('notification'), body, `${label} notification`);
      ts = Number(delivery.request.headers['envoi-wake-timestamp']);
      assert.equal(body.id, delivery.request.headers['envoi-wake-id'], `${label}: header id is the body id`);
      assert.equal(body.subscriptionId, subscription.id, `${label}: the body names the subscription`);
      assert.equal(JSON.stringify(body), delivery.request.bodyText, `${label}: the body is compact JSON`);
      assert.equal(body.type === 'wake.challenge', isChallenge, `${label}: a pending subscription gets only its challenge, an active one never`);
      if (body.type === 'wake.work_available') assert.notEqual(context.agentStatus, 'paused', `${label}: no work notification while the agent is paused (§8.1)`);
      // §2.3: opaque. No content, address, token, URL or internal id, and an id that is not derived from anything.
      // subscriptionId is checked by its schema; fixture ids are readable, real ones are random.
      const { type, reason, subscriptionId, ...rest } = body;
      assert.doesNotMatch(JSON.stringify(rest), privateWakeContent, `${label}: no private content in the notification`);
      if (reason) assert.ok(!body.id.includes(reason), `${label}: the id does not encode the reason`);
      assert.ok(!body.id.includes(String(body.sequence).padStart(4, '0')), `${label}: the id does not encode the sequence`);
      assert.ok(type, `${label}: typed`);
      // §3.2, §6.2: attempts start no earlier than the schedule allows, and never after the deadline.
      const created = Math.floor(Date.parse(body.createdAt) / 1000);
      const earliest = created + (isChallenge ? limits.challengeFirstAttemptDelaySeconds : 0)
        + limits.retryScheduleSeconds.slice(0, delivery.attempt - 1).reduce((sum, seconds) => sum + Math.floor(seconds * (1 - limits.retryJitterRatio)), 0);
      assert.ok(ts >= earliest, `${label}: attempt ${delivery.attempt} starts no earlier than the schedule allows`);
      if (isChallenge) assert.equal(body.expiresAt, subscription.challengeExpiresAt, `${label}: the challenge expires with the subscription's window`);
    }
    // §6.2: the class follows the response or transport phase; the outcome follows the class, the cap and the deadline.
    const sentClass = delivery.sent ? wakeFailureClass(delivery, limits) : 'address_rejected';
    assert.equal(delivery.failureClass, sentClass, `${label}: failure class for the response`);
    const failure = delivery.failureClass && schemas['x-failure-classes'][delivery.failureClass];
    const retryable = failure && (isChallenge ? failure.challengeRetryable : failure.retryable);
    const maxAttempts = isChallenge ? limits.challengeMaxAttempts : limits.maxAttempts;
    const base = limits.retryScheduleSeconds[delivery.attempt - 1] ?? 0;
    const retryAfter = [429, 503].includes(delivery.response?.status) && /^\d+$/.test(delivery.response.headers?.['retry-after'] || '') ? Math.min(Number(delivery.response.headers['retry-after']), limits.retryAfterMaxSeconds) : 0;
    const low = Math.max(Math.floor(base * (1 - limits.retryJitterRatio)), retryAfter);
    const high = Math.max(Math.ceil(base * (1 + limits.retryJitterRatio)), retryAfter);
    const deadline = body && (isChallenge ? Date.parse(body.expiresAt) / 1000 : Date.parse(body.createdAt) / 1000 + limits.deliveryDeadlineSeconds);
    if (body) assert.ok(ts <= deadline, `${label}: no attempt starts after the deadline`);
    const outcome = !failure ? 'acknowledged' : !retryable ? 'failed' : delivery.attempt >= maxAttempts || (body && ts + low > deadline) ? 'exhausted' : delivery.outcome === 'exhausted' && body && ts + high > deadline ? 'exhausted' : 'retry_scheduled';
    assert.equal(delivery.outcome, outcome, `${label}: outcome`);
    if (outcome === 'retry_scheduled') {
      assert.ok(delivery.nextAttemptInSeconds >= low && delivery.nextAttemptInSeconds <= high, `${label}: next attempt in ${low}–${high} s`);
      if (body) assert.ok(ts + delivery.nextAttemptInSeconds <= deadline, `${label}: the next attempt starts before the deadline`);
    }
    assert.ok(delivery.attempt <= maxAttempts, `${label}: at most ${maxAttempts} attempts`);
  }
  if (receiver) {
    assert.ok(delivery.request, `${label}: a receiver verdict needs a request`);
    if (delivery.origin === 'server') {
      assert.equal(receiver.registeredUrl, context.subscription.url, `${label}: the receiver registered this url`);
      if (delivery.response) {
        assert.equal(delivery.response.status, receiver.respondStatus, `${label}: the server saw the receiver's status`);
        assert.deepEqual(delivery.response.headers || {}, receiver.respondHeaders, `${label}: the server saw the receiver's headers`);
      }
    }
    const derived = wakeReceiverVerdict(delivery.request, receiver, schemas, validator);
    assert.equal(receiver.verdict, derived.verdict, `${label}: receiver verdict (x-receiver-checks)`);
    assert.equal(receiver.reason, derived.reason, `${label}: receiver reason`);
    const row = schemas['x-receiver-checks'].find((entry) => entry.check === (derived.reason || derived.verdict));
    const acknowledged = [row.status, ...(row.alsoAllowed || [])].includes(receiver.respondStatus) && receiver.respondStatus < 300;
    if (derived.verdict === 'process') {
      // A receiver that verified the request may still answer 410, or a retryable status (§6.2); then it acts on nothing.
      assert.ok(acknowledged || [408, 410, 425, 429].includes(receiver.respondStatus) || receiver.respondStatus >= 500, `${label}: a verified request is acknowledged, refused as gone, or deferred`);
      assert.equal(receiver.action, acknowledged ? (schemas['x-wake-reasons'][derived.body.type]?.action ?? 'none') : 'none', `${label}: action for ${derived.body.type}`);
    } else {
      assert.equal(receiver.respondStatus, row.status, `${label}: status for ${row.check}`);
      if (row.retryAfterSeconds) assert.equal(receiver.respondHeaders['retry-after'], String(row.retryAfterSeconds), `${label}: retry-after for ${row.check}`);
      assert.equal(receiver.action, 'none', `${label}: rejected, deferred and duplicate requests act on nothing`);
    }
  }
}

// http-wake v1 rules a schema cannot express. Applied to each step of a fixture.
function checkHttpWake(fixture, schemas, check, validator, label) {
  const flags = { ENVOI_HTTP_WAKE_V1: true, ENVOI_INSTALLATIONS_V2: true, ...fixture.flags };
  assert.ok(!(flags.ENVOI_HTTP_WAKE_V1 && !flags.ENVOI_INSTALLATIONS_V2), `${label}: the wake flag requires installations (§1)`);
  const steps = fixture.steps ? fixture.steps.map((step, index) => ({ ...step, label: `${label} step ${index}` })) : [{ ...fixture, label }];
  assert.doesNotMatch(JSON.stringify(fixture), /envoi_wake_challenge_(?!PLACEHOLDER)/, `${label}: challenges are placeholders`);
  for (const [index, step] of steps.entries()) {
    const stepLabel = step.label;
    if (step.delivery) {
      checkWakeDelivery(step, fixture, schemas, check, validator, stepLabel);
      // §6.3: triggers during an attempt only set the dirty flag; exactly one follow-up is created after that attempt.
      if (step.context?.triggersDuringAttempt) {
        const id = step.delivery.request.headers['envoi-wake-id'];
        const later = steps.slice(index + 1).filter((entry) => entry.delivery?.request && entry.delivery.request.headers['envoi-wake-id'] !== id);
        assert.equal(new Set(later.map((entry) => entry.delivery.request.headers['envoi-wake-id'])).size, 1, `${stepLabel}: exactly one follow-up notification`);
        const [first, follow] = [JSON.parse(step.delivery.request.bodyText), JSON.parse(later[0].delivery.request.bodyText)];
        assert.equal(follow.sequence, first.sequence + 1, `${stepLabel}: the follow-up is the next sequence`);
        assert.ok(follow.createdAt >= (step.receiver?.clock ?? first.createdAt), `${stepLabel}: the follow-up is created after the attempt was acknowledged`);
      }
      continue;
    }
    const { request, response, client } = step;
    const body = response.body;
    const code = body && typeof body === 'object' ? body.code : undefined;
    const pathname = request.path.split('?')[0];
    const context = step.context || fixture.context || {};
    if (request.schema && !caseSessionSchema(request.schema)) check(validator(request.schema), request.body, `${stepLabel} request`);
    if (request.invalidAgainst) {
      const validate = validator(request.invalidAgainst);
      assert.equal(validate(request.body), false, `${stepLabel}: the negative request must fail ${request.invalidAgainst}`);
      assert.ok(validate.errors.some((error) => error.keyword === request.invalidBecause?.keyword && error.instancePath === request.invalidBecause?.instancePath), `${stepLabel}: fails for the named reason`);
    }
    if (request.method === 'POST' && (wakeHostRoute.test(pathname) || wakeOwnerRoute.test(pathname))) assert.ok(request.schema || request.invalidAgainst, `${stepLabel}: a wake POST names its body schema`);
    if (fixture.steps && !caseSessionSchema(response.schema)) {
      check(validator(response.schema), body, `${stepLabel} response`);
      checkCodedError(response, client, schemas, stepLabel);
    }
    // The bearer matches the declared auth.
    const authorization = request.headers?.authorization;
    if (wakeBearerPrefix[request.auth]) assert.ok(String(authorization).startsWith(wakeBearerPrefix[request.auth]), `${stepLabel}: ${request.auth} bearer`);
    else assert.equal(authorization, undefined, `${stepLabel}: no bearer for ${request.auth}`);
    if (request.auth === 'human_session') assert.match(String(request.headers.cookie), /(?:^|;\s*)envoi_session=/, `${stepLabel}: a human session cookie`);
    const wakeRoute = wakeHostRoute.test(pathname) || wakeOwnerRoute.test(pathname) || pathname === wakeKeysRoute;
    // §1: the flag decides FEATURE_DISABLED on the wake routes, and nothing else returns it.
    assert.equal(code === 'FEATURE_DISABLED', wakeRoute && !flags.ENVOI_HTTP_WAKE_V1, `${stepLabel}: FEATURE_DISABLED exactly on a wake route with the flag off`);
    // §3: only the host's access token reaches the host routes; only a signed-in human the owner routes.
    if (wakeHostRoute.test(pathname) && flags.ENVOI_HTTP_WAKE_V1 && request.auth !== 'agent_access') assert.equal(code, 'AUTHENTICATION_REQUIRED', `${stepLabel}: only an access token manages wake`);
    if (wakeOwnerRoute.test(pathname)) assert.equal(request.auth, 'human_session', `${stepLabel}: owner routes take a human session`);
    if (pathname === wakeKeysRoute) assert.equal(request.auth, 'none', `${stepLabel}: the key set is public`);
    const create = request.method === 'POST' && pathname === '/api/agent/wake-subscriptions';
    const activate = /\/activate$/.test(pathname);
    if (code === 'WAKE_URL_REJECTED') assert.ok(create, `${stepLabel}: WAKE_URL_REJECTED only on create`);
    if (['WAKE_CHALLENGE_INVALID', 'WAKE_SUBSCRIPTION_ENDED'].includes(code)) assert.ok(activate, `${stepLabel}: ${code} only on activate`);
    // §3.1, §4: a create is accepted exactly when no rule fails, and a URL that fails a rule needing no lookup is never resolved.
    if (create && request.schema === 'createRequest' && (!code || code === 'WAKE_URL_REJECTED')) {
      const syntax = wakeUrlRejection(request.body.url, undefined, schemas);
      if (syntax) assert.equal(context.dns, undefined, `${stepLabel}: no DNS lookup for a URL that fails a rule needing no lookup`);
      const expected = syntax || wakeUrlRejection(request.body.url, context.dns, schemas);
      assert.equal(code === 'WAKE_URL_REJECTED' ? body.reason : null, expected, `${stepLabel}: the first rule the URL breaks (x-url-checks)`);
      if (!expected) assert.ok(context.dns, `${stepLabel}: an accepted URL was resolved`);
    }
    if (create && code === 'RATE_LIMITED' && body.reason) {
      assert.equal(context.dns, undefined, `${stepLabel}: the create limit is checked before any lookup`);
      assert.equal(wakeUrlRejection(request.body.url, undefined, schemas), null, `${stepLabel}: and after the rules that need no lookup`);
    }
    if (!code && response.status < 300) {
      const expected = pathname === wakeKeysRoute ? `public, max-age=${schemas['x-limits'].jwksMaxAgeSeconds}` : wakeRoute ? 'no-store' : undefined;
      if (expected) assert.equal(response.headers?.['cache-control'], expected, `${stepLabel}: cache-control`);
      if (!caseSessionSchema(response.schema)) {
        // §2.2, §12: a host reading an ended subscription as its newest follows x-ended-reasons; any other success is none/none.
        const newest = response.schema === 'agentStatusHttpWake' ? body.httpWake.subscription : response.schema === 'hostSubscriptionList' ? body.subscriptions[0] : undefined;
        const row = newest?.status === 'ended' ? schemas['x-ended-reasons'][newest.endedReason] : undefined;
        assert.deepEqual([client.retry, client.guidance], row ? [row.hostRetry, row.hostGuidance] : ['none', 'none'], `${stepLabel}: client retry and guidance for this success`);
        const lifecycle = client.surface === 'owner' ? 'NOT_APPLICABLE' : response.schema === 'agentStatusHttpWake' ? (body.state === 'paused' ? 'PAUSED' : 'RUNNING') : 'UNCHANGED';
        assert.equal(client.lifecycle, lifecycle, `${stepLabel}: lifecycle for this success`);
      }
    }
    if (code) assert.equal(response.headers?.['cache-control'], 'no-store', `${stepLabel}: errors are not cached`);
    // §5.2: one active key, at most one next; ids unique; the set says when it came into force.
    if (response.schema === 'jwks') {
      assert.equal(body.keys.filter((key) => key.status === 'active').length, 1, `${stepLabel}: exactly one active key`);
      assert.ok(body.keys.filter((key) => key.status === 'next').length <= 1, `${stepLabel}: at most one next key`);
      assert.equal(new Set(body.keys.map((key) => key.kid)).size, body.keys.length, `${stepLabel}: key ids are unique`);
      assert.ok(context.validFrom && context.rotation, `${stepLabel}: a key set names when and how it came into force`);
    }
    if (response.schema === 'agentStatusHttpWake') {
      assert.equal(body.httpWake.available, flags.ENVOI_HTTP_WAKE_V1, `${stepLabel}: httpWake.available is the flag`);
      if (!flags.ENVOI_HTTP_WAKE_V1) assert.equal(body.httpWake.subscription, null, `${stepLabel}: no subscription is reported with the flag off`);
    }
    const subscriptions = response.schema === 'subscriptionResponse' ? [body.subscription] : ['hostSubscriptionList', 'ownerSubscriptionList'].includes(response.schema) ? body.subscriptions : [];
    for (const [position, subscription] of subscriptions.entries()) checkWakeSubscription(subscription, schemas, `${stepLabel} subscription ${position}`);
    if (response.schema === 'hostSubscriptionList') {
      assert.ok(body.subscriptions.every((entry) => entry.installationId === body.installationId), `${stepLabel}: the host sees only its installation`);
      checkWakeList(body.subscriptions, schemas['x-limits'].hostEndedListMax, stepLabel);
    }
    if (response.schema === 'ownerSubscriptionList') {
      assert.ok(body.subscriptions.every((entry) => entry.agentId === body.agentId), `${stepLabel}: the owner sees this agent's subscriptions`);
      checkWakeList(body.subscriptions, schemas['x-limits'].ownerEndedListMax, stepLabel);
    }
    if (response.schema === 'subscriptionResponse') {
      const { subscription } = body;
      if (create) {
        assert.deepEqual([subscription.status, subscription.url, subscription.activatedAt, subscription.delivery.state], ['pending', new URL(request.body.url).href, null, 'unverified'], `${stepLabel}: a create returns a pending, unverified subscription for the canonical url`);
      } else {
        assert.equal(pathname.split('/').at(-2), subscription.id, `${stepLabel}: the response is the subscription in the path`);
        const action = pathname.split('/').at(-1);
        const expected = context.subscription?.status === 'ended' ? ['ended', context.subscription.endedReason]
          : activate ? ['active', null] : action === 'revoke' ? ['ended', 'revoked_by_owner'] : ['ended', 'ended_by_host'];
        assert.deepEqual([subscription.status, subscription.endedReason], expected, `${stepLabel}: status after ${action}`);
      }
    }
  }
  // §1: the status summary is the installation's active subscription, else its pending one, else its latest ended one.
  const status = steps.find((step) => step.response?.schema === 'agentStatusHttpWake' && step.response.body.httpWake.subscription);
  const list = steps.find((step) => step.response?.schema === 'hostSubscriptionList');
  if (status && list) {
    const entries = list.response.body.subscriptions;
    const pick = entries.find((entry) => entry.status === 'active') || entries.find((entry) => entry.status === 'pending') || entries.find((entry) => entry.status === 'ended');
    assert.deepEqual(status.response.body.httpWake.subscription, pick && { id: pick.id, status: pick.status, endedReason: pick.endedReason, expiresAt: pick.expiresAt }, `${label}: the status summary picks from the list`);
  }
  // §6.2: a notification's attempts rise by one, carry the identical body, are signed again, and respect the delay.
  const byId = new Map();
  for (const step of steps.filter((entry) => entry.delivery?.origin === 'server' && entry.delivery.request)) {
    const id = step.delivery.request.headers['envoi-wake-id'];
    const previous = byId.get(id);
    if (previous) {
      assert.equal(step.delivery.attempt, previous.delivery.attempt + 1, `${step.label}: the next attempt`);
      assert.equal(step.delivery.request.bodyText, previous.delivery.request.bodyText, `${step.label}: a retry carries the identical body`);
      assert.notEqual(step.delivery.request.headers['envoi-wake-signature'], previous.delivery.request.headers['envoi-wake-signature'], `${step.label}: each attempt is signed again`);
      const waited = Number(step.delivery.request.headers['envoi-wake-timestamp']) - Number(previous.delivery.request.headers['envoi-wake-timestamp']);
      assert.ok(waited >= previous.delivery.nextAttemptInSeconds, `${step.label}: started no earlier than scheduled`);
    }
    byId.set(id, step);
  }
}

// case-session §5: the x-case-tools rows a permission set allows for one work kind, in table order.
const readPermissions = ['send_agent_messages', 'receive_agent_messages'];
const permits = (permissions, needs) => (Array.isArray(needs) ? needs.every((need) => permits(permissions, need))
  : needs === 'read' ? permissions.some((permission) => readPermissions.includes(permission)) : permissions.includes(needs));
const caseSessionTools = (schemas, permissions, workKind) => schemas['x-case-tools']
  .filter((tool) => tool.workKinds.includes(workKind) && permits(permissions, tool.needs))
  .map((tool) => tool.name);
const sessionRoute = /^\/api\/agent\/work\/[^/]+\/session(?:\/end)?$/;

// case-session v1 rules a schema cannot express. Applied to each exchange of a fixture.
function checkCaseSession(fixture, schemas, check, validator, label) {
  const flags = { ENVOI_CASE_SESSIONS_V1: true, ENVOI_INSTALLATIONS_V2: true, ...fixture.flags };
  const exchanges = fixture.steps ? fixture.steps.map((step, index) => ({ ...step, context: step.context || fixture.context, label: `${label} step ${index}` }))
    : fixture.request ? [{ request: fixture.request, response: fixture.response, client: fixture.client, context: fixture.context, label }] : [];
  const limits = schemas['x-limits'];
  for (const { request, response, client, context, label: stepLabel } of exchanges) {
    const body = response.body;
    const code = body && typeof body === 'object' ? body.code : undefined;
    const pathname = request.path.split('?')[0];
    if (request.schema) check(validator(request.schema), request.body, `${stepLabel} request`);
    if (request.invalidAgainst) {
      const validate = validator(request.invalidAgainst);
      assert.equal(validate(request.body), false, `${stepLabel}: the negative request must fail ${request.invalidAgainst}`);
      assert.ok(validate.errors.some((error) => error.keyword === request.invalidBecause?.keyword && error.instancePath === request.invalidBecause?.instancePath), `${stepLabel}: fails for the named reason`);
    }
    if (fixture.steps) {
      check(validator(response.schema), body, `${stepLabel} response`);
      // §7.3, §13: today's settlement body appears only with the flag off.
      if (response.schema === 'legacyRequestFailed') assert.equal(flags.ENVOI_CASE_SESSIONS_V1, false, `${stepLabel}: legacy settlement bodies only with the flag off`);
      else checkCodedError(response, client, schemas, stepLabel);
    }
    if (code) assert.equal(client.turn, codeEntry(schemas, code, client.surface).turn, `${stepLabel}: turn for ${code}`);
    // §1: the flag decides FEATURE_DISABLED on the session routes, and nothing else returns it.
    assert.equal(code === 'FEATURE_DISABLED', sessionRoute.test(pathname) && !flags.ENVOI_CASE_SESSIONS_V1, `${stepLabel}: FEATURE_DISABLED exactly on a session route with the flag off`);
    // §6.1: a session token works only on /mcp, and only with the flag on. §3 row 3: only an access token mints or ends.
    if (request.auth === 'case_session' && (pathname !== '/mcp' || !flags.ENVOI_CASE_SESSIONS_V1)) assert.equal(code, 'AUTHENTICATION_REQUIRED', `${stepLabel}: a session token outside /mcp is an unrecognized bearer`);
    if (sessionRoute.test(pathname) && flags.ENVOI_CASE_SESSIONS_V1 && request.auth !== 'agent_access') assert.equal(code, 'AUTHENTICATION_REQUIRED', `${stepLabel}: only an access token reaches the session routes`);
    if (pathname === '/mcp' && response.status === 401) {
      const expected = ['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED'].includes(code) ? 'Bearer realm="Envoi agent MCP", error="invalid_token"' : 'Bearer realm="Envoi agent MCP"';
      assert.equal(response.headers?.['www-authenticate'], expected, `${stepLabel}: www-authenticate`);
    }
    // §6.2: x-implied-conditions hold in every context.
    if (context?.ended) {
      for (const [reason, implied] of Object.entries(schemas['x-implied-conditions'])) {
        if (context.ended[reason]) for (const other of implied) assert.ok(context.ended[other], `${stepLabel}: ${reason} implies ${other}`);
      }
    }
    // §6.2 steps 2–4: the outcome a session request gets from its context. Rate limiting (step 1) may come first.
    if (pathname === '/mcp' && request.auth === 'case_session' && code !== 'RATE_LIMITED') {
      if (!flags.ENVOI_CASE_SESSIONS_V1 || context?.createdBeforeEpoch || !context) {
        assert.equal(code, 'AUTHENTICATION_REQUIRED', `${stepLabel}: flag off, a session older than the epoch, or an unknown token is an unrecognized bearer (§1, §6.2 step 2)`);
      } else {
        assert.ok(context.ended, `${stepLabel}: a session request names its conditions`);
        const derived = schemas['x-ended-precedence'].find((reason) => context.ended[reason]);
        const recorded = context.recordedReason;
        // Steps 3–5: the recorded reason, else expiry, else the first holding condition.
        const expected = recorded === 'expired' ? { code: 'CASE_SESSION_EXPIRED' }
          : recorded ? { code: 'CASE_SESSION_ENDED', reason: recorded }
            : context.expired ? { code: 'CASE_SESSION_EXPIRED' }
              : derived ? { code: 'CASE_SESSION_ENDED', reason: derived } : { code: undefined };
        assert.equal(code, expected.code, `${stepLabel}: §6.2 outcome for this context`);
        if (expected.reason) assert.equal(body.reason, expected.reason, `${stepLabel}: the recorded reason, else the first holding condition in x-ended-precedence`);
        if (!code) assert.equal(body.id, request.body.id, `${stepLabel}: the JSON-RPC id is echoed`);
      }
    }
    if (code === 'CASE_SESSION_ENDED') assert.ok(!schemas['x-recorded-only-reasons'].includes(body.reason), `${stepLabel}: expired is reported as CASE_SESSION_EXPIRED`);
    // §3: what a minted session carries.
    if (response.schema === 'sessionCreated') {
      const { session, lease } = body;
      assert.ok(context?.permissions && context.workKind, `${stepLabel}: a mint names its permissions and work kind`);
      assert.equal(pathname, `/api/agent/work/${session.workId}/session`, `${stepLabel}: the session is for the requested work`);
      assert.equal(lease.workId, session.workId, `${stepLabel}: the lease is the session's work`);
      assert.equal(session.workKind, context.workKind, `${stepLabel}: work kind`);
      assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), limits.sessionTtlSeconds * 1000, `${stepLabel}: expiresAt is createdAt + sessionTtlSeconds`);
      assert.ok(Date.parse(lease.leaseExpiresAt) > Date.parse(session.createdAt), `${stepLabel}: minted under a live lease`);
      assert.deepEqual(session.allowedTools, caseSessionTools(schemas, context.permissions, session.workKind), `${stepLabel}: allowedTools follows x-case-tools`);
      assert.equal(session.counterparty.kind === 'agent', session.workKind !== 'human_instruction', `${stepLabel}: counterparty kind follows the work kind (a human decision's counterparty is the other agent)`);
    }
    if (['sessionCreated', 'sessionEnded'].includes(response.schema) || code) assert.equal(response.headers?.['cache-control'], 'no-store', `${stepLabel}: no-store`);
    // §6.4: tools/list is the effective set; tools/call outside it, or with a scope field, fails before anything runs.
    if (pathname === '/mcp' && response.status === 200 && !['initialize', 'ping', 'tools/list', 'tools/call'].includes(request.body.method)) {
      assert.equal(body.error?.code, -32601, `${stepLabel}: an unknown method is -32601`);
      assert.equal(client.turn, 'continue', `${stepLabel}: the turn continues`);
    }
    if (pathname === '/mcp' && response.status === 200 && ['tools/list', 'tools/call'].includes(request.body.method)) {
      assert.ok(context?.allowedTools, `${stepLabel}: an MCP tool fixture names its session's allowedTools`);
      const effective = context.allowedTools.filter((name) => caseSessionTools(schemas, context.permissions, context.workKind).includes(name));
      if (request.body.method === 'tools/list') assert.deepEqual(body.result.tools.map((tool) => tool.name), effective, `${stepLabel}: tools/list is the effective set`);
      else {
        const { name, arguments: args = {} } = request.body.params;
        const dataCode = body.error?.data?.code;
        assert.equal(dataCode === 'TOOL_NOT_IN_SESSION', !effective.includes(name), `${stepLabel}: TOOL_NOT_IN_SESSION exactly outside the effective set`);
        if (effective.includes(name) && Object.keys(args).some((key) => schemas['x-scope-fields'].includes(key))) assert.equal(dataCode, 'TOOL_ARGUMENTS_INVALID', `${stepLabel}: a scope field is refused (§6.3)`);
        if (body.error) assert.equal(client.turn, 'continue', `${stepLabel}: a JSON-RPC refusal leaves the turn running`);
      }
    }
    // §4: model-visible keys are allowlisted, equal their source, and carry no token or id.
    if (client.modelVisible) {
      assert.equal(response.schema, 'sessionCreated', `${stepLabel}: model-visible keys come from a minted session`);
      const { session } = body;
      const { serverDerived, fromStatus } = schemas['x-model-visible'];
      for (const key of Object.keys(client.modelVisible)) assert.ok(key in serverDerived || key in fromStatus, `${stepLabel}: ${key} is not model-visible`);
      if ('agentAddress' in client.modelVisible) assert.match(client.modelVisible.agentAddress, /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, `${stepLabel}: agentAddress is an address`);
      assert.ok(context.turnStartedAt >= session.createdAt && context.turnStartedAt < session.expiresAt, `${stepLabel}: the turn starts inside the session`);
      const sources = { counterpartyKind: session.counterparty.kind, counterpartyAddress: session.counterparty.address, allowedTools: session.allowedTools, sessionExpiresInSeconds: (Date.parse(session.expiresAt) - Date.parse(context.turnStartedAt)) / 1000 };
      for (const [key, value] of Object.entries(client.modelVisible)) {
        if (key in serverDerived) assert.deepEqual(value, sources[key], `${stepLabel}: model-visible ${key} equals its source`);
      }
      const shown = JSON.stringify(client.modelVisible);
      for (const secret of [session.token, session.id, session.agentId, session.installationId, session.workId, session.caseId, request.body?.leaseToken]) assert.ok(!shown.includes(secret), `${stepLabel}: model-visible values never include ${secret}`);
      assert.doesNotMatch(shown, /envoi_(?:agent_|mcp_read_|case_session_|reg_)|PLACEHOLDER/, `${stepLabel}: model-visible values carry no token`);
    }
  }
}

// case-tools §2, §4: what a tool result may never carry, and how every reference looks.
const internalIdPattern = /\b(?:case|msg|agent|inbox|installation|case_session|session|credential_family|asset|evt|event|policy_eval|policy_exec|option|proposal|work|human|org|receipt|action|conversation|registration|enrollment)_(?!(?:action|decision)\b)[A-Za-z0-9-]{4,}/; // human_action is an event kind, not an id
const toolTokenPattern = /envoi_(?:agent_|mcp_read_|case_session_|reg_)|lease_PLACEHOLDER/;
const emailPattern = /[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+/g;
function collectRefs(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'ref' || key.endsWith('Ref') || key === 'inReplyTo') && typeof item === 'string') found.push(item);
      collectRefs(item, found);
    }
  }
  return found;
}
const parseToolText = (response) => JSON.parse(response.body.result.content[0].text);

// case-tools v1 rules a schema cannot express. Applied to each exchange of a fixture.
const messageKinds = ['message', 'proposal', 'counterproposal', 'decision', 'completion'];
function checkCaseTools(fixture, schemas, check, validator, label) {
  const limits = schemas['x-limits'];
  const implemented = schemas['x-tools'].filter((tool) => tool.inputSchema).map((tool) => tool.name);
  const untrustedFields = new Set(schemas['x-untrusted-fields']);
  const bytes = (value) => Buffer.byteLength(value, 'utf8');
  // §6.4: a text within its limit; a truncated text was cut on a code-point boundary at most 3 bytes short of it.
  const checkText = (value, truncated, max, what) => {
    assert.ok(bytes(value) <= max, `${what} within ${max} bytes`);
    if (truncated) assert.ok(bytes(value) > max - 4, `${what} was cut at its limit`);
  };
  const exchanges = fixture.steps ? fixture.steps.map((step, index) => ({ ...step, context: step.context || fixture.context, label: `${label} step ${index}` }))
    : fixture.request ? [{ request: fixture.request, response: fixture.response, client: fixture.client, context: fixture.context, label }] : [];
  for (const { request, response, client, context, label: stepLabel } of exchanges) {
    check(validator(request.schema), request.body, `${stepLabel} request`);
    if (fixture.steps) {
      check(validator(response.schema), response.body, `${stepLabel} response`);
      checkCodedError(response, client, schemas, stepLabel);
    }
    if (response.body?.code) assert.equal(client.turn, codeEntry(schemas, response.body.code, client.surface).turn, `${stepLabel}: turn for ${response.body.code}`);
    assert.equal(response.body.id ?? request.body.id, request.body.id, `${stepLabel}: the JSON-RPC id is echoed`);
    const serverRevision = context.serverRevision ?? 3;
    const effective = schemas['x-tools'].filter((tool) => tool.inputSchema && tool.revision <= serverRevision && context.allowedTools.includes(tool.name)).map((tool) => tool.name);
    if (request.body.method === 'tools/list') {
      // §1: tools/list is the implemented effective set, with input schemas verbatim.
      const listed = response.body.result.tools;
      assert.deepEqual(listed.map((tool) => tool.name), effective, `${stepLabel}: tools/list is the implemented effective set`);
      for (const tool of listed) assert.deepEqual(tool.inputSchema, schemas['x-tools'].find((entry) => entry.name === tool.name).inputSchema, `${stepLabel}: ${tool.name} inputSchema is verbatim`);
      continue;
    }
    const { name, arguments: args = {} } = request.body.params;
    const tool = schemas['x-tools'].find((entry) => entry.name === name);
    assert.ok(tool, `${stepLabel}: x-tools lists ${name}`);
    const inSession = effective.includes(name);
    if (response.schema === 'jsonRpcError') {
      // §1: a tool outside the session (or not implemented) is TOOL_NOT_IN_SESSION; otherwise arguments that fail its
      // inputSchema are TOOL_ARGUMENTS_INVALID. Either way nothing runs and the turn continues.
      const dataCode = response.body.error.data.code;
      assert.equal(dataCode === 'TOOL_NOT_IN_SESSION', !inSession, `${stepLabel}: TOOL_NOT_IN_SESSION exactly outside the session`);
      if (dataCode === 'TOOL_ARGUMENTS_INVALID') assert.equal(new Ajv({ allErrors: true, strict: false }).validate(tool.inputSchema, args), false, `${stepLabel}: TOOL_ARGUMENTS_INVALID means the arguments fail ${name}'s inputSchema`);
      assert.equal(client.turn, 'continue', `${stepLabel}: the turn continues`);
      continue;
    }
    if (response.schema !== 'mcpToolCallResult') continue;
    assert.ok(inSession, `${stepLabel}: the session carries ${name}`);
    assert.equal(new Ajv({ allErrors: true, strict: false }).validate(tool.inputSchema, args), true, `${stepLabel}: a tool that ran had valid arguments`);
    const text = response.body.result.content[0].text;
    assert.ok(bytes(text) <= limits.resultMaxBytes, `${stepLabel}: result within resultMaxBytes`);
    const document = parseToolText(response);
    check(validator(response.toolResult), document, `${stepLabel} tool result`);
    assert.equal(document.ok, !response.body.result.isError, `${stepLabel}: ok mirrors isError`);
    assert.equal(document.tool, name, `${stepLabel}: the result names its tool`);
    // §2, §4: model context carries no token anywhere, and no internal id, URL or other email outside the untrusted
    // fields (§5), whose content other parties wrote and the server never rewrites.
    assert.doesNotMatch(text, toolTokenPattern, `${stepLabel}: no token in a tool result`);
    const serverWritten = JSON.stringify(document, (key, value) => (untrustedFields.has(key) ? undefined : value));
    assert.doesNotMatch(serverWritten, internalIdPattern, `${stepLabel}: no internal id in a tool result`);
    assert.doesNotMatch(serverWritten, /https?:\/\//, `${stepLabel}: no URL in a tool result`);
    const known = [document.result?.you?.address, document.result?.counterparty?.address, document.result?.recipient?.address].filter(Boolean);
    for (const email of serverWritten.match(emailPattern) || []) assert.ok(known.includes(email), `${stepLabel}: no email but the agent addresses (${email})`);
    if (!document.ok) {
      const entry = schemas['x-tool-errors'][document.code];
      assert.equal(document.retryable, entry.retryable, `${stepLabel}: retryable for ${document.code}`);
      assert.equal(document.message, entry.message, `${stepLabel}: the fixed message for ${document.code}`);
      assert.equal(client.retry, entry.clientRetry, `${stepLabel}: client retry for ${document.code}`);
      continue;
    }
    for (const value of collectRefs(document.result)) assert.match(value, /^[mpoaegqr]_[a-z2-7]{16}$/, `${stepLabel}: ${value} is a reference`);
    const { result } = document;
    if (name === 'envoi_case_snapshot') {
      const limit = args.eventLimit ?? limits.eventLimitDefault;
      assert.ok(result.recentEvents.length <= limit, `${stepLabel}: at most eventLimit events`);
      assert.ok(result.recentEvents.every((event, index, list) => index === 0 || list[index - 1].at <= event.at), `${stepLabel}: events oldest first`);
      assert.equal(result.page.hasOlder, result.page.olderCursor !== null, `${stepLabel}: olderCursor exactly when hasOlder`);
      assert.equal('requestedResponse' in result, !args.eventsBefore, `${stepLabel}: requestedResponse only on a first page`);
      assert.equal(result.counterparty.kind === 'agent', context.workKind !== 'human_instruction', `${stepLabel}: counterparty kind follows the work kind (a human decision's counterparty is the other agent)`);
      if (result.requestedResponse) {
        assert.equal(result.requestedResponse.from === 'your_human', context.workKind !== 'agent_message', `${stepLabel}: the work comes from your workspace exactly for an instruction or a human decision`);
        assert.equal(result.requestedResponse.kind === 'human_decision', context.workKind === 'human_decision', `${stepLabel}: human_decision work is answered as such`);
        checkText(result.requestedResponse.text, result.requestedResponse.truncated, limits.requestedTextMaxBytes, `${stepLabel}: requested text`);
        // §6.2: when the work message is in the page it shares requestedResponse's reference and carries no text.
        const workItem = result.recentEvents.find((event) => event.ref === result.requestedResponse.ref);
        if (workItem) assert.equal(workItem.text, null, `${stepLabel}: the work message's timeline item carries no text`);
      }
      // §1, §6.2, §12.1: allowedActions is the implemented effective set, narrowed by the state rules, in x-tools order.
      const decision = result.authority.lastPolicyDecision;
      const awaiting = result.proposal !== null && result.proposal.lastActor === 'other_agent';
      const closed = ['completed', 'failed', 'expired'].includes(result.case.status);
      const completable = !closed && !result.authority.pendingHumanDecision;
      const stateAllows = (tool) => (closed ? ['envoi_case_snapshot', 'envoi_case_list_assets'].includes(tool) : ({
        envoi_case_propose: result.proposal === null,
        envoi_authority_check: awaiting || completable,
        envoi_case_decide: awaiting,
        envoi_case_share_asset: result.assetsHasMore || result.assets.some((item) => item.origin === 'you' && item.scan === 'clean' && !item.shared),
        envoi_case_complete: completable,
        envoi_request_human: decision?.decision === 'needsHuman' && decision.humanApproval === 'pending' && !result.authority.pendingHumanDecision
      })[tool] ?? true);
      assert.deepEqual(result.allowedActions, effective.filter(stateAllows), `${stepLabel}: allowedActions`);
      if (decision) assert.equal(decision.humanApproval === 'not_required', decision.decision !== 'needsHuman', `${stepLabel}: humanApproval follows the decision`);
      assert.ok(bytes(JSON.stringify({ ...result, recentEvents: [] })) <= limits.fixedSectionsMaxBytes, `${stepLabel}: fixed sections within fixedSectionsMaxBytes`);
      for (const event of result.recentEvents) {
        // §6.3: your own messages carry a delivery status and nothing else does; instructions and receipts carry no intent.
        assert.equal(event.deliveryStatus !== null, event.actor === 'you' && messageKinds.includes(event.kind), `${stepLabel}: deliveryStatus exactly on your own messages`);
        if (['instruction', 'instruction_reply', 'receipt'].includes(event.kind)) assert.equal(event.intent, null, `${stepLabel}: ${event.kind} carries no intent`);
        // §6.2: only the work message's own item leaves its text to requestedResponse.
        if ([...messageKinds, 'instruction', 'instruction_reply'].includes(event.kind) && event.ref !== result.requestedResponse?.ref) assert.notEqual(event.text, null, `${stepLabel}: message ${event.ref} carries its text`);
        if (event.kind === 'human_action') assert.equal(event.actor, 'your_human', `${stepLabel}: only your workspace's human actions are projected`);
        if (event.kind === 'receipt') assert.match(event.ref, /^r_/, `${stepLabel}: a receipt keeps its r_ reference in the timeline`);
        if (event.text) checkText(event.text, event.truncated, limits.eventTextMaxBytes, `${stepLabel}: event text`);
      }
      for (const option of result.proposal?.options || []) {
        assert.equal(option.value === null, option.truncated, `${stepLabel}: a dropped option value is marked truncated`);
        if (option.value) assert.ok(bytes(JSON.stringify(option.value)) <= limits.optionValueMaxBytes, `${stepLabel}: option value within its byte limit`);
      }
      for (const asset of result.assets) {
        assert.ok(bytes(asset.filename) <= limits.filenameMaxBytes && bytes(asset.mimeType) <= limits.mimeTypeMaxBytes, `${stepLabel}: asset names within their byte limits`);
      }
    }
    if (name === 'envoi_case_reply') {
      assert.equal(result.recipient.kind === 'agent', context.workKind !== 'human_instruction', `${stepLabel}: the recipient is the session counterparty`);
      assert.equal(result.status, context.workKind === 'human_instruction' ? 'delivered' : 'queued', `${stepLabel}: delivered for an instruction, queued otherwise`);
    }
    // §12.2–§12.5: revision 2 results agree with their arguments.
    if (name === 'envoi_authority_check') {
      assert.equal(result.action, args.action, `${stepLabel}: the checked action`);
      assert.deepEqual([result.proposalRef, result.optionRef], [args.proposalRef ?? null, args.optionRef ?? null], `${stepLabel}: the authority is bound to the requested option, or to none for complete_case`);
      assert.equal(result.humanApproval === 'not_required', result.decision !== 'needsHuman', `${stepLabel}: humanApproval follows the decision`);
    }
    if (name === 'envoi_request_human') {
      assert.equal(result.authorityRef, args.authorityRef, `${stepLabel}: the request names its authority`);
      assert.equal(client.turn, 'end', `${stepLabel}: endTurn means the host ends the turn now`);
    }
    if (name === 'envoi_case_propose') assert.equal(result.recipient.kind, 'agent', `${stepLabel}: an offer goes to the other agent`);
    // §14.2: list mode and single mode; inline content only for a clean, small text asset.
    if (name === 'envoi_case_list_assets') {
      if (args.assetRef) {
        assert.equal(result.asset.ref, args.assetRef, `${stepLabel}: the requested asset`);
        if (args.includeContent) assert.equal(result.asset.scan, 'clean', `${stepLabel}: content is only ever returned for a clean asset`);
        const inline = limits.inlineContentTypes.includes(result.asset.mimeType) && result.asset.size <= limits.inlineContentMaxBytes;
        if (args.includeContent) {
          assert.equal(result.content !== null, inline, `${stepLabel}: content exactly for a small text asset`);
          assert.equal(result.contentUnavailable, inline ? null : limits.inlineContentTypes.includes(result.asset.mimeType) ? 'too_large' : 'binary', `${stepLabel}: the reason content is unavailable`);
          if (result.content) {
            assert.equal(bytes(result.content.text), result.asset.size, `${stepLabel}: the inline text is the whole file`);
            assert.equal(crypto.createHash('sha256').update(result.content.text).digest('base64'), result.asset.checksumSha256, `${stepLabel}: the inline text matches checksumSha256`);
          }
        } else assert.deepEqual([result.content, result.contentUnavailable], [null, null], `${stepLabel}: no content unless asked`);
      } else {
        assert.ok(result.assets.length <= (args.limit ?? limits.listLimitDefault), `${stepLabel}: at most limit assets`);
        assert.equal(result.hasMore, result.nextCursor !== null, `${stepLabel}: nextCursor exactly when hasMore`);
      }
    }
    // §14.3: shared with the session counterparty only.
    if (name === 'envoi_case_share_asset') {
      assert.equal(result.assetRef, args.assetRef, `${stepLabel}: the shared asset`);
      assert.equal(result.recipient.kind, 'agent', `${stepLabel}: shared with the other agent`);
    }
    // §14.4: completion writes a receipt and completes the case, whatever the work's settlement.
    if (name === 'envoi_case_complete') {
      assert.deepEqual(result.evidenceRefs, args.evidenceRefs ?? [], `${stepLabel}: the evidence the completion cites`);
      if (args.authorityRef) assert.equal(result.humanApproval, 'approved', `${stepLabel}: completing under an approved authority records the person's decision`);
    }
    if (name === 'envoi_case_decide') {
      assert.equal(result.decision, args.decision, `${stepLabel}: the decision made`);
      assert.equal(result.proposalRef, args.proposalRef, `${stepLabel}: the decided proposal`);
      assert.equal(result.proposalStatus, { accept: 'accepted', counter: 'countered', reject: 'withdrawn' }[args.decision], `${stepLabel}: proposal status`);
      if (args.decision === 'accept') assert.deepEqual([result.optionRef, result.caseStatus], [args.optionRef, 'authorized'], `${stepLabel}: an accept authorizes the case with the accepted option`);
      if (args.decision === 'reject') assert.equal(result.optionRef, null, `${stepLabel}: a reject names no option`);
      if (args.decision === 'counter') assert.notEqual(result.optionRef, null, `${stepLabel}: a counter names its new option`);
    }
  }
}

test('contract fixture registry has a versioned shape', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  assert.equal(Number.isInteger(index.version) && index.version >= 1, true);
  assert.equal(Array.isArray(index.contracts), true);
  const ids = new Set();
  for (const contract of index.contracts) {
    assert.match(contract.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(contract.id), false, `duplicate contract id ${contract.id}`);
    ids.add(contract.id);
    assert.equal(Number.isInteger(contract.version) && contract.version >= 1, true, contract.id);
    assert.ok(['published', 'approved'].includes(contract.status), contract.id);
    assert.equal(typeof contract.handoff, 'string', contract.id);
    assert.equal(contract.dir, contract.id);
    assert.equal(contract.schemas === undefined || typeof contract.schemas === 'string', true, contract.id);
    assert.equal(Array.isArray(contract.fixtures) && contract.fixtures.length > 0, true, contract.id);
  }
});

test('every registered fixture exists, parses and is registered exactly once', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  for (const contract of index.contracts) {
    const dir = path.join(root, contract.dir);
    const onDisk = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== contract.schemas).sort();
    assert.deepEqual([...contract.fixtures].sort(), onDisk, `${contract.id} fixture list`);
    for (const name of contract.fixtures) await readJson(path.join(dir, name));
  }
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, index.contracts.map((contract) => contract.dir).sort(), 'unregistered fixture directory');
});

test('every fixture matches its declared schema', async () => {
  const index = await readJson(path.join(root, 'index.json'));
  for (const contract of index.contracts.filter((entry) => entry.schemas)) {
    const dir = path.join(root, contract.dir);
    const schemas = await readJson(path.join(dir, contract.schemas));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(schemas);
    const validator = (name) => {
      const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
      assert.ok(validate, `${contract.id} has no schema ${name}`);
      return validate;
    };
    const check = (validate, value, label) => assert.equal(validate(value), true, `${label}: ${ajv.errorsText(validate.errors)}`);
    for (const name of contract.fixtures) {
      const fixture = await readJson(path.join(dir, name));
      const label = `${contract.id}/${name}`;
      check(validator('fixture'), fixture, label);
      assert.equal(fixture.contract, contract.id, label);
      assert.equal(fixture.version, contract.version, label);
      assert.equal(`${fixture.id}.json`, name, label);
      if (fixture.response) {
        const value = 'body' in fixture.response ? fixture.response.body : fixture.response.bodyText;
        check(validator(fixture.response.schema), value, `${label} response`);
        if (value && typeof value === 'object' && 'code' in value) {
          assert.equal(value.error, value.code, `${label}: error must equal code`);
          const entry = codeEntry(schemas, value.code, fixture.client.surface);
          assert.ok(entry, `${label}: ${value.code} is not in x-codes`);
          assert.equal(fixture.response.status, entry.status, `${label}: HTTP status for ${value.code}`);
          assert.equal(fixture.client.lifecycle, entry.lifecycle, `${label}: lifecycle for ${value.code}`);
          assert.equal(fixture.client.retry, expectedRetry(entry, value), `${label}: retry for ${value.code}`);
          assert.equal(fixture.client.guidance, expectedGuidance(entry, value, fixture.client), `${label}: guidance for ${value.code}`);
        } else if (fixture.response.status >= 400 && schemas['x-codes']) {
          assert.equal(fixture.response.schema, 'edgeText', `${label}: error responses must use the error envelope`);
        }
        // envoi-browser-names: the plain { error } shape is kept only for browser requests (a3 §1).
        if (fixture.response.schema === 'plainError') assert.ok(fixture.request?.headers?.cookie, `${label}: plainError is only for browser requests`);
        if (fixture.response.status === 302) {
          assert.match(String(fixture.response.headers?.location || ''), /^(?:\/|https:\/\/)/, `${label}: a redirect has a location`);
          assert.equal(fixture.response.headers['cache-control'], 'no-store', `${label}: redirects are not cached`);
        }
        const workMessage = fixture.response.body?.work?.message;
        if (workMessage && !['humanInstruction', 'humanDecision'].includes(workMessage.kind)) {
          // Claimed native work must be a stored message the server could have produced.
          assert.doesNotThrow(() => assertValidProtocolMessage(Object.fromEntries(protocolFields.map((key) => [key, workMessage[key]]))), `${label}: protocol envelope`);
          assert.equal(workMessage.id, workMessage.messageId, `${label}: id is the protocol messageId`);
          assert.equal(workMessage.caseId, workMessage.conversationId, `${label}: caseId is the conversationId`);
          assert.equal(workMessage.from.agentId, workMessage.senderAgentId, `${label}: from is the sender`);
          assert.ok(workMessage.to.some((recipient) => recipient.agentId === workMessage.recipientAgentId), `${label}: to includes the recipient`);
        }
        if (fixture.response.status === 429) assert.equal(fixture.response.headers?.['retry-after'], String(value.retryAfterSeconds), `${label}: retry-after`);
      }
      if (fixture.event) {
        check(validator(fixture.event.schema), fixture.event.data, `${label} event`);
        if (fixture.event.id !== undefined) assert.equal(fixture.event.event, fixture.event.data.type, `${label}: SSE event name`);
        if (fixture.event.id !== undefined) assert.equal(fixture.event.id, fixture.event.data.cursor, `${label}: SSE id is the cursor`);
        else assert.equal('cursor' in fixture.event.data, false, `${label}: control events carry no cursor`);
      }
      if (fixture.frames) checkStreamFrames(fixture, label, check, validator);
      if (fixture.response?.schema === 'deltaPage') checkDeltaPage(fixture, label);
      if (schemas['x-browser-cookies']) checkBrowserNames(fixture, schemas, label);
      // envoi-browser-names v1 §6, every contract: no request sends a retired cookie or header name
      // unless the fixture is about exactly that. Old token prefixes (envoi-names v1) are values, not names.
      if (!fixture.oldNamesInRequest) {
        const headers = fixture.request?.headers || {};
        assert.ok(!Object.keys(headers).some(name => /^x-sinaloa-/i.test(name)), `${label}: no retired header names in the request`);
        assert.doesNotMatch(String(headers.cookie || ''), /(?:^|;\s*)sinaloa_/, `${label}: no retired cookie names in the request`);
      }
      if (['ownerAgentList', 'ownerAgent'].includes(fixture.response?.schema)) checkOwnerConnection(fixture, schemas, label);
      if (fixture.response?.schema === 'agentStatusWithPresence') checkPresence(fixture.response.body.presence, fixture.response.body.asOf, label);
      if (contract.id === 'http-wake') checkHttpWake(fixture, schemas, check, validator, label);
      if (contract.id === 'agent-registration') checkAgentRegistration(fixture, schemas, check, validator, label);
      if (contract.id === 'case-session') checkCaseSession(fixture, schemas, check, validator, label);
      if (contract.id === 'case-tools') checkCaseTools(fixture, schemas, check, validator, label);
      assert.doesNotMatch(JSON.stringify(fixture), /(?:(?:envoi|sinaloa)_agent_(?:access|refresh)_|(?:envoi|sinaloa)_mcp_read_|(?:envoi|sinaloa)_enroll_|envoi_reg_|envoi_case_session_)(?!PLACEHOLDER)/, `${label}: tokens must be placeholders`);
    }
  }
});

// agent-registration §5.3 and §6.2: replays repeat the original response exactly, and fixtures that
// describe one registration agree with each other.
test('agent-registration fixtures agree across cases', async () => {
  const dir = path.join(root, 'agent-registration');
  const load = (name) => readJson(path.join(dir, `${name}.json`));
  const schemas = await load('schemas');
  const [created, recovered] = await Promise.all([load('activation-created'), load('activation-recovered')]);
  assert.deepEqual(recovered.response.body, created.response.body, 'activation recovery returns the identical body');
  const [approved, replayed] = await Promise.all([load('claim-approve-new-agent'), load('claim-approve-replayed')]);
  assert.deepEqual(replayed.response.body, approved.response.body, 'an identical approval replays the identical body');
  assert.deepEqual(replayed.request.body, approved.request.body, 'the replayed approval is the identical request');
  const [registration, lookup, polled] = await Promise.all([load('registration-created'), load('claim-lookup'), load('registration-approved')]);
  assert.deepEqual(lookup.response.body.requestedPermissions, registration.request.body.requestedPermissions, 'lookup shows what the agent requested');
  assert.equal(lookup.response.body.verificationCode, registration.response.body.claim.verificationCode, 'lookup finds the registration by its code');
  assert.deepEqual(approved.context.requestedPermissions, registration.request.body.requestedPermissions, 'approval context is the registration');
  assert.deepEqual(polled.response.body.effectivePermissions, approved.response.body.effectivePermissions, 'polling reports the approved permissions');
  assert.deepEqual(polled.response.body.agent, approved.response.body.agent, 'polling reports the approved agent');
  assert.equal(polled.response.body.workspaceName, approved.response.body.workspaceName, 'polling reports the approving workspace');
  const [existing, pausedActivation, rejected, rejectReplayed] = await Promise.all([load('claim-approve-existing-agent'), load('activation-paused-agent'), load('claim-reject'), load('claim-reject-replayed')]);
  assert.deepEqual(existing.context.requestedPermissions, registration.request.body.requestedPermissions, 'existing-agent approval context is the registration');
  assert.deepEqual(pausedActivation.response.body.effectivePermissions, existing.response.body.effectivePermissions, 'activation applies the approved permissions to the existing agent');
  assert.equal(pausedActivation.response.body.agent.id, existing.response.body.agent.id, 'activation attaches the approved existing agent');
  assert.deepEqual(rejectReplayed.response.body, rejected.response.body, 'a replayed reject repeats the original');
  const [lateReplay, withdrawn, withdrawReplayed] = await Promise.all([load('claim-approve-replayed-after-activation'), load('claim-withdraw'), load('claim-withdraw-replayed')]);
  assert.deepEqual([lateReplay.request.body, lateReplay.response], [approved.request.body, approved.response], 'an identical approval replays the original after activation too');
  assert.deepEqual([withdrawReplayed.request, withdrawReplayed.response], [withdrawn.request, withdrawn.response], 'a replayed withdrawal repeats the original');
  const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
  assert.equal(seconds(lookup.response.body.createdAt, lookup.response.body.expiresAt), schemas['x-limits'].registrationTtlSeconds, 'the claim window is registrationTtlSeconds');
  assert.equal(polled.response.body.activationExpiresAt, approved.response.body.activationExpiresAt, 'polling reports the approved activation deadline');
  const unresolved = await load('activation-token-invalid-unresolved');
  const createdActivation = await load('activation-created');
  assert.deepEqual(unresolved.request, createdActivation.request, 'the unresolved retry is the identical activation request');
  assert.equal(unresolved.client.helperState, 'activation_unresolved', 'the unresolved retry declares its helper state');
  const several = await load('owner-installations-legacy-several');
  const limits = schemas['x-limits'];
  assert.ok(several.stored.credentialFamilies.filter((family) => family.revokedAt).length > limits.ownerInstallationEndedMax, 'the legacy fixture stores more ended families than the list shows');
  assert.ok(several.stored.credentialFamilies.filter((family) => !family.revokedAt).length >= 2, 'the legacy fixture has several active families');
  assert.equal(schemas.definitions.ownerClaimList.properties.claims.maxItems, limits.ownerClaimListMax, 'claim list bound matches x-limits');
  assert.ok(limits.deleteRecordsByHours > limits.deleteRecordsAfterHours, 'records are deleted after they are kept');
  const create = limits.registrationCreate;
  assert.ok(create.perSourcePerHour <= create.perNetworkPerHour && create.perNetworkPerHour <= create.perWideNetworkPerHour, 'creation limits widen with the network');
});

// http-wake §3, §5, §6, §7 and §12: fixtures that describe one flow agree with each other, every subscription has one
// consistent timeline, every server attempt is signed by the key active at that moment, and the handoff's fixture
// table lists exactly the registered fixtures.
test('http-wake fixtures agree across cases', async () => {
  const dir = path.join(root, 'http-wake');
  const load = (name) => readJson(path.join(dir, `${name}.json`));
  const schemas = await load('schemas');
  const definitions = schemas.definitions;
  const limits = schemas['x-limits'];
  const seconds = (value) => Date.parse(value) / 1000;
  const index = await readJson(path.join(root, 'index.json'));
  const names = index.contracts.find((contract) => contract.id === 'http-wake').fixtures.map((name) => name.replace(/\.json$/, ''));
  const all = new Map(await Promise.all(names.map(async (name) => [name, await load(name)])));
  const steps = [...all.values()].flatMap((fixture) => (fixture.steps || [fixture]).map((step) => ({ fixture, ...step, context: step.context || fixture.context })));
  const deliveries = steps.filter((step) => step.delivery);
  const exchanges = steps.filter((step) => step.request && step.response);

  // Claim and mint steps are case-session v1's own schemas, validated by that contract's definitions.
  const caseSession = await readJson(path.join(root, 'case-session', 'schemas.json'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(caseSession);
  const wakeAjv = new Ajv({ allErrors: true, strict: false });
  addFormats(wakeAjv);
  wakeAjv.addSchema(schemas);
  const isNotification = wakeAjv.getSchema(`${schemas.$id}#/definitions/notification`);
  for (const { fixture, request, response } of exchanges) {
    for (const [value, name] of [[request.body, request.schema], [response.body, response.schema]]) {
      if (!caseSessionSchema(name)) continue;
      const validate = ajv.getSchema(`${caseSession.$id}#/definitions/${name.slice('case-session#'.length)}`);
      assert.ok(validate, `${fixture.id}: case-session has ${name}`);
      assert.equal(validate(value), true, `${fixture.id}: ${name}: ${ajv.errorsText(validate.errors)}`);
    }
  }

  // Tables agree with the schema enums, in both directions.
  assert.deepEqual(schemas['x-url-checks'], definitions.urlRejectedReason.enum, 'x-url-checks is the reason enum, in order');
  assert.deepEqual(Object.keys(schemas['x-failure-classes']), definitions.failureClass.enum, 'x-failure-classes is the class enum');
  assert.deepEqual(Object.keys(schemas['x-ended-reasons']), definitions.endedReason.enum, 'x-ended-reasons is the reason enum');
  assert.deepEqual(Object.keys(schemas['x-codes']), definitions.errorCode.enum, 'x-codes is the code enum');
  assert.deepEqual(schemas['x-receiver-checks'].filter((row) => ['reject', 'defer'].includes(row.verdict)).map((row) => row.check), definitions.receiver.properties.reason.anyOf[0].enum, 'x-receiver-checks is the receiver reason enum');
  assert.deepEqual(Object.keys(schemas['x-wake-reasons']['wake.work_available'].reasons), definitions.notificationWork.properties.reason.enum, 'work reasons match');
  assert.deepEqual(Object.keys(schemas['x-wake-reasons']['wake.control_changed'].reasons), definitions.notificationControl.properties.reason.enum, 'control reasons match');
  assert.deepEqual(schemas['x-signing'].headers, definitions.deliveryHeaders.required, 'x-signing headers are the delivery headers');
  const endedRow = schemas['x-codes'].WAKE_SUBSCRIPTION_ENDED.bySurface.host;
  for (const [reason, row] of Object.entries(schemas['x-ended-reasons'])) {
    assert.deepEqual([endedRow.retryByReason[reason], endedRow.guidanceByReason[reason]], [row.hostRetry, row.hostGuidance], `WAKE_SUBSCRIPTION_ENDED ${reason} follows x-ended-reasons`);
  }
  const window = limits.retryScheduleSeconds.reduce((sum, value) => sum + Math.ceil(value * (1 + limits.retryJitterRatio)), 0);
  assert.ok(window <= limits.deliveryDeadlineSeconds, 'the jittered schedule fits the delivery deadline');
  assert.equal(limits.dedupeCacheRecommendedSeconds, limits.deliveryDeadlineSeconds + limits.timestampToleranceSeconds, 'the recommended dedupe window is the deadline plus the tolerance');

  // §5.2, §5.4: key sets in force over time. A routine rotation promotes the published next key and retires the old one
  // with grace; an emergency one may replace it at once. Every server attempt is signed by the key active in the set in
  // force at its timestamp, and verifies.
  const sets = ['keys-published', 'keys-rotated', 'keys-emergency'].map((name) => ({ name, from: seconds(all.get(name).context.validFrom), rotation: all.get(name).context.rotation, set: all.get(name).response.body })).sort((a, b) => a.from - b.from);
  const status = (set, kid) => set.keys.find((key) => key.kid === kid)?.status;
  for (const [position, current] of sets.entries()) {
    if (position === 0) continue;
    const previous = sets[position - 1];
    const [previousActive] = previous.set.keys.filter((key) => key.status === 'active');
    const [active] = current.set.keys.filter((key) => key.status === 'active');
    if (current.rotation === 'routine') {
      assert.equal(status(previous.set, active.kid), 'next', `${current.name}: the active key was published as next`);
      assert.ok(current.from - previous.from >= limits.keyPublishLeadSeconds, `${current.name}: after keyPublishLeadSeconds`);
      const retired = current.set.keys.find((key) => key.kid === previousActive.kid);
      assert.equal(retired?.status, 'retired', `${current.name}: the old active key is retired`);
      assert.ok(seconds(retired.notAfter) - current.from >= limits.keyRetireGraceSeconds, `${current.name}: a retired key stays published for keyRetireGraceSeconds`);
    }
    for (const key of current.set.keys) {
      const before = previous.set.keys.find((entry) => entry.kid === key.kid);
      if (before) assert.equal(before.x, key.x, `${current.name}: ${key.kid} keeps its public key`);
    }
  }
  const inForce = (ts) => [...sets].reverse().find((entry) => entry.from <= ts).set;
  for (const { fixture, receiver } of deliveries.filter((entry) => entry.receiver)) {
    assert.ok(sets.some((entry) => JSON.stringify(entry.set) === JSON.stringify(receiver.jwks)), `${fixture.id}: the receiver holds a published key set`);
  }
  const unknown = all.get('wake-unknown-key').delivery.request.headers['envoi-wake-key-id'];
  assert.ok(!sets.some((entry) => status(entry.set, unknown)), 'the forged key is never published');
  const serverSent = deliveries.filter((entry) => entry.delivery.origin === 'server' && entry.delivery.request);
  for (const { fixture, delivery } of serverSent) {
    const key = inForce(Number(delivery.request.headers['envoi-wake-timestamp'])).keys.find((entry) => entry.status === 'active');
    assert.equal(delivery.request.headers['envoi-wake-key-id'], key.kid, `${fixture.id}: signed with the key active at its timestamp`);
    assert.ok(wakeSignatureValid(delivery.request, delivery.request.url, key), `${fixture.id}: the signature verifies`);
  }

  // §2.3: per subscription, sequence follows creation order and names one notification. This includes third-party
  // copies whose signature verifies, since only Envoi could have produced them.
  const envoiSigned = deliveries.filter(({ delivery }) => {
    if (!delivery.request) return false;
    if (delivery.origin === 'server') return true;
    const key = sets.flatMap((entry) => entry.set.keys).find((entry) => entry.kid === delivery.request.headers['envoi-wake-key-id']);
    return key && wakeSignatureValid(delivery.request, delivery.request.url, key);
  }).map((entry) => ({ ...entry, body: JSON.parse(entry.delivery.request.bodyText) })).filter((entry) => isNotification(entry.body));
  const bySubscription = new Map();
  for (const { fixture, body } of envoiSigned) {
    const bySequence = bySubscription.get(body.subscriptionId) || new Map();
    const known = bySequence.get(body.sequence);
    if (known) assert.equal(known.id, body.id, `${fixture.id}: sequence ${body.sequence} of ${body.subscriptionId} is one notification`);
    bySequence.set(body.sequence, body);
    bySubscription.set(body.subscriptionId, bySequence);
  }
  for (const [subscriptionId, bySequence] of bySubscription) {
    const ordered = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    assert.ok(ordered.every((body, position) => position === 0 || ordered[position - 1].createdAt <= body.createdAt), `${subscriptionId}: sequence follows createdAt`);
  }

  // §6.3: per subscription and lane, a notification is created only once the previous one is no longer live.
  const lane = (type) => (type === 'wake.control_changed' ? 'control' : type === 'wake.challenge' ? 'challenge' : 'work');
  const live = new Map();
  for (const { delivery } of serverSent) {
    const body = JSON.parse(delivery.request.bodyText);
    const key = `${body.subscriptionId} ${lane(body.type)}`;
    const ts = Number(delivery.request.headers['envoi-wake-timestamp']);
    const intervals = live.get(key) || new Map();
    const interval = intervals.get(body.id) || { created: seconds(body.createdAt), end: ts };
    interval.end = Math.max(interval.end, ts + (delivery.nextAttemptInSeconds || 0));
    intervals.set(body.id, interval);
    live.set(key, intervals);
  }
  for (const [key, intervals] of live) {
    const list = [...intervals.entries()];
    for (const [id, interval] of list) {
      for (const [otherId, other] of list) {
        if (id !== otherId) assert.ok(!(other.created > interval.created && other.created < interval.end), `${key}: ${otherId} is created while ${id} is live`);
      }
    }
  }

  // One timeline per subscription id across every fixture: one url, installation, agent and creation time, one ending,
  // no attempt after it, a replaced subscription's end at its successor's activation, and receivers that only hold ids
  // that exist and have not ended.
  const timeline = new Map();
  const objects = [];
  for (const { fixture, response } of exchanges) {
    const body = response.body;
    const list = response.schema === 'subscriptionResponse' ? [body.subscription] : ['hostSubscriptionList', 'ownerSubscriptionList'].includes(response.schema) ? body.subscriptions : [];
    for (const subscription of list) objects.push({ fixture, subscription });
  }
  for (const { fixture, subscription } of objects) {
    const known = timeline.get(subscription.id);
    if (!known) { timeline.set(subscription.id, { ...subscription, where: fixture.id }); continue; }
    for (const field of ['url', 'installationId', 'agentId', 'createdAt']) assert.equal(subscription[field], known[field], `${fixture.id}: ${subscription.id} ${field} agrees with ${known.where}`);
    for (const field of ['activatedAt', 'endedReason', 'endedAt']) {
      if (subscription[field] && known[field]) assert.equal(subscription[field], known[field], `${fixture.id}: ${subscription.id} ${field} agrees with ${known.where}`);
      if (subscription[field] && !known[field]) known[field] = subscription[field];
    }
  }
  for (const { fixture, subscription } of objects.filter((entry) => entry.subscription.endedReason === 'replaced')) {
    assert.ok(objects.some(({ subscription: other }) => other.installationId === subscription.installationId && other.id !== subscription.id && other.activatedAt === subscription.endedAt), `${fixture.id}: ${subscription.id} ended when a successor activated`);
  }
  for (const { fixture, context, delivery } of serverSent) {
    const known = timeline.get(context.subscription.id);
    if (known) assert.equal(context.subscription.url, known.url, `${fixture.id}: context url of ${context.subscription.id}`);
    if (known?.endedAt) assert.ok(Number(delivery.request.headers['envoi-wake-timestamp']) <= seconds(known.endedAt), `${fixture.id}: no attempt after ${context.subscription.id} ended`);
  }
  for (const { fixture, receiver } of deliveries.filter((entry) => entry.receiver)) {
    for (const id of receiver.subscriptionIds) {
      const known = timeline.get(id);
      if (!known) continue;
      assert.ok(known.createdAt <= receiver.clock, `${fixture.id}: the receiver holds ${id} only after it was created`);
      if (known.endedAt) assert.ok(known.endedAt > receiver.clock, `${fixture.id}: the receiver holds ${id} only until it ends`);
    }
  }

  // §3.6, §3.7: the host list is the owner list for that installation.
  const hostList = all.get('host-subscription-list').response.body;
  const ownerList = all.get('owner-subscription-list').response.body;
  assert.deepEqual(hostList.subscriptions, ownerList.subscriptions.filter((entry) => entry.installationId === hostList.installationId), 'the host list is the owner list for its installation');

  // §7.2: a replay is the identical request; the altered one differs only in its body.
  const signed = all.get('wake-delivered-signed').delivery.request;
  assert.deepEqual(all.get('wake-replayed').delivery.request, signed, 'the replay is byte-identical');
  assert.deepEqual({ ...all.get('wake-replayed-to-other-receiver').delivery.request, url: signed.url }, signed, 'the cross-receiver replay changes only the target');
  const altered = all.get('wake-invalid-signature').delivery.request;
  assert.deepEqual(altered.headers, signed.headers, 'the altered request keeps the original headers');
  assert.notEqual(altered.bodyText, signed.bodyText, 'and changes the body');

  // §3.1–§3.3: the challenge sent to the URL is the one the host activates with, for the subscription it created.
  const created = all.get('subscription-created');
  const challenge = JSON.parse(all.get('challenge-delivered').delivery.request.bodyText);
  const activation = all.get('subscription-activated');
  assert.equal(challenge.subscriptionId, created.response.body.subscription.id, 'the challenge names the created subscription');
  assert.equal(challenge.expiresAt, created.response.body.subscription.challengeExpiresAt, 'the challenge expires with the subscription\'s window');
  assert.equal(activation.request.body.challenge, challenge.challenge, 'the host activates with the delivered challenge');
  assert.equal(activation.request.headers.authorization, created.request.headers.authorization, 'by the installation that created it');
  assert.equal(activation.response.body.subscription.id, challenge.subscriptionId, 'the activated subscription is the created one');
  const replayed = all.get('subscription-activate-replayed');
  assert.deepEqual([replayed.request, replayed.response], [activation.request, activation.response], 'an identical activation repeats the original');
  const [endedByHost, endedAgain] = [all.get('subscription-ended-by-host'), all.get('subscription-end-replayed')];
  assert.deepEqual([endedAgain.request, endedAgain.response], [endedByHost.request, endedByHost.response], 'ending twice repeats the first ending');
  assert.notEqual(all.get('subscription-activate-wrong-challenge').request.body.challenge, challenge.challenge, 'the wrong challenge differs');
  assert.notEqual(all.get('subscription-activate-not-found').request.headers.authorization, activation.request.headers.authorization, 'another installation cannot activate it');

  // §3.2: the challenge race is resolved by a retry once the host knows the id.
  const race = all.get('challenge-before-create-response').steps;
  assert.deepEqual([race[0].receiver.verdict, race[0].receiver.subscriptionIds], ['defer', []], 'the receiver defers before it knows the id');
  assert.ok(race[2].receiver.subscriptionIds.includes(race[1].response.body.subscription.id), 'and accepts once the create response arrived');

  // §3.4: replacements take over from the active subscription with no gap.
  const replacement = all.get('subscription-replacement-flow').steps;
  const replacementCreated = replacement[0].response.body.subscription;
  assert.equal(JSON.parse(replacement[1].delivery.request.bodyText).challenge, replacement[2].request.body.challenge, 'it activates with its own challenge');
  const oldEntry = replacement[3].response.body.subscriptions.find((entry) => entry.id === replacementCreated.replacesSubscriptionId);
  assert.equal(oldEntry.endedAt, replacement[2].response.body.subscription.activatedAt, 'the old subscription ends in the activation\'s transaction');
  assert.equal(replacement[4].context.subscription.id, oldEntry.id, 'and gets nothing more');
  assert.equal(JSON.parse(replacement[5].delivery.request.bodyText).reason, 'subscription_activated', 'the new subscription is woken at once');
  const sameUrl = all.get('subscription-replacement-same-url').steps;
  assert.equal(sameUrl[0].response.body.subscription.url, sameUrl[1].context.subscription.url, 'the same URL');
  for (const step of sameUrl.slice(1)) assert.deepEqual([...step.receiver.subscriptionIds].sort(), [sameUrl[0].response.body.subscription.replacesSubscriptionId, sameUrl[0].response.body.subscription.id].sort(), 'the receiver holds both ids for the URL');

  // §3.1: the lost create leaves only the retried subscription able to activate.
  const lost = all.get('subscription-create-lost-response-retry').steps;
  assert.equal(lost[0].delivered, false, 'the first create response was lost');
  assert.deepEqual(lost[1].request, lost[0].request, 'the retry is the identical request');
  assert.equal(lost[2].response.body.subscriptions.find((entry) => entry.id === lost[0].response.body.subscription.id).endedReason, 'superseded', 'the lost one is superseded');

  // §3: the stored url is canonical, and signatures bind it.
  const canonical = all.get('subscription-created-canonical-url').steps;
  assert.notEqual(canonical[0].request.body.url, canonical[0].response.body.subscription.url, 'the typed url differs from the stored one');
  assert.equal(canonical[1].delivery.request.url, canonical[0].response.body.subscription.url, 'notifications go to the stored url');

  // §5.3, §5.4: after an emergency rotation the receiver defers, refreshes and accepts the retry.
  const emergency = all.get('wake-emergency-rotation').steps;
  assert.deepEqual([emergency[0].receiver.verdict, emergency[0].receiver.reason], ['defer', 'unknown_key'], 'the stale receiver defers');
  assert.deepEqual(emergency[2].receiver.jwks, emergency[1].response.body, 'and verifies the retry with the refreshed set');
  assert.equal(emergency[2].delivery.request.headers['envoi-wake-id'], emergency[0].delivery.request.headers['envoi-wake-id'], 'the same notification');

  // §7.4: the receiver claims with its own credentials, correlates by wake id, and mints for the claimed lease.
  const [wake, claim, mint] = all.get('wake-then-claim-and-mint').steps;
  const wakeId = wake.delivery.request.headers['envoi-wake-id'];
  assert.equal(claim.request.path, '/api/agent/work/claim', 'the receiver claims at the fixed claim route');
  assert.equal(claim.request.headers['x-request-id'], wakeId, 'the claim carries the wake id for correlation');
  assert.equal(claim.request.headers.authorization, all.get('agent-status-http-wake').request.headers.authorization, 'with the access token of the installation that owns the subscription');
  assert.equal(mint.request.body.leaseToken, claim.response.body.work.leaseToken, 'the session is minted for the claimed lease');
  assert.equal(mint.request.path, `/api/agent/work/${claim.response.body.work.workId}/session`, 'for the claimed work, which the wake never named');
  assert.ok(!wake.delivery.request.bodyText.includes(claim.response.body.work.workId), 'the wake did not name the work');
  assert.equal(mint.response.body.session.installationId, all.get('agent-status-http-wake').response.body.installation.id, 'minted by the same installation');

  // §6.5, §7.2: restarts on either side lose nothing and duplicate nothing canonical.
  const serverRestart = all.get('wake-server-restart-recovery').steps;
  assert.equal(serverRestart[0].delivery.failureClass, 'interrupted', 'the server stopped mid-attempt');
  assert.equal(serverRestart[1].receiver.verdict, 'duplicate', 'the receiver recognizes the retried id');
  const receiverRestart = all.get('wake-receiver-restart-recovery').steps;
  assert.deepEqual(receiverRestart[1].receiver.seenIds, [], 'the restarted receiver forgot its ids');
  assert.equal(receiverRestart[2].response.body.state, 'idle', 'the extra claim is idle');
  const exhausted = all.get('wake-retries-exhausted').steps;
  assert.equal(exhausted.filter((step) => step.delivery).length, limits.maxAttempts, 'exactly maxAttempts attempts');
  const safetyClaim = exhausted.find((step) => step.response?.schema === 'case-session#claimClaimed');
  assert.equal(safetyClaim.response.body.work.workId, claim.response.body.work.workId, 'the safety poll claims the work the wakes announced');
  assert.equal(safetyClaim.request.headers.authorization, exhausted.at(-1).request.headers.authorization, 'with the installation that owns the subscription');

  // Every rule has a fixture.
  const urlReasons = exchanges.map((step) => step.response.body?.code === 'WAKE_URL_REJECTED' && step.response.body.reason).filter(Boolean);
  for (const reason of schemas['x-url-checks']) assert.ok(urlReasons.includes(reason), `a fixture covers WAKE_URL_REJECTED ${reason}`);
  for (const reason of Object.keys(schemas['x-failure-classes'])) assert.ok(deliveries.some((entry) => entry.delivery.failureClass === reason), `a fixture covers failure class ${reason}`);
  for (const row of schemas['x-receiver-checks']) assert.ok(deliveries.some((entry) => entry.receiver && (entry.receiver.reason || entry.receiver.verdict) === row.check), `a fixture covers receiver check ${row.check}`);
  for (const reason of definitions.delivery.properties.notSentReason.enum) assert.ok(deliveries.some((entry) => entry.delivery.notSentReason === reason), `a fixture covers not-sent reason ${reason}`);
  const endedSeen = new Set(exchanges.flatMap((step) => {
    const body = step.response.body;
    if (body?.code === 'WAKE_SUBSCRIPTION_ENDED') return [body.reason];
    const list = step.response.schema === 'subscriptionResponse' ? [body.subscription] : ['hostSubscriptionList', 'ownerSubscriptionList'].includes(step.response.schema) ? body.subscriptions : [];
    return list.map((subscription) => subscription.endedReason).filter(Boolean);
  }));
  for (const reason of Object.keys(schemas['x-ended-reasons'])) assert.ok(endedSeen.has(reason), `a fixture covers ended reason ${reason}`);
  const sentBodies = deliveries.filter((entry) => entry.delivery.origin === 'server' && entry.delivery.request).map((entry) => JSON.parse(entry.delivery.request.bodyText));
  for (const [type, { reasons }] of Object.entries(schemas['x-wake-reasons'])) {
    assert.ok(sentBodies.some((body) => body.type === type), `a fixture sends ${type}`);
    for (const reason of Object.keys(reasons)) assert.ok(sentBodies.some((body) => body.type === type && body.reason === reason), `a fixture sends ${type} ${reason}`);
  }
  for (const [code, row] of Object.entries(schemas['x-codes'])) {
    for (const surface of Object.keys(row.bySurface)) assert.ok(exchanges.some((step) => step.response.body?.code === code && step.client.surface === surface), `a fixture covers ${code} for ${surface}`);
  }
  assert.ok(exchanges.some((step) => step.response.body?.code === 'RATE_LIMITED' && !step.response.body.reason), 'a fixture covers the a3 request limit');

  const handoff = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
  const sectionStart = handoff.indexOf('\n## http-wake v1');
  assert.ok(sectionStart >= 0, 'handoffs.md has the http-wake v1 section');
  const sectionEnd = handoff.indexOf('\n## ', sectionStart + 1);
  const section = handoff.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const table = section.slice(section.indexOf('| Group | Fixtures |'), section.indexOf('### 13.'));
  const inTable = [...table.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]).sort();
  assert.deepEqual(inTable, [...names].sort(), 'the handoff lists exactly the registered fixtures');
});

// case-session §11 and §14: replays repeat the original, retries and reclaims keep one live session, and the
// handoff's fixture table lists exactly the registered fixtures.
test('case-session fixtures agree across cases', async () => {
  const dir = path.join(root, 'case-session');
  const load = (name) => readJson(path.join(dir, `${name}.json`));
  const bearer = (request) => request.headers.authorization;
  const [created, list, receiveOnly, end, endReplayed] = await Promise.all(['session-created', 'session-tools-list', 'session-created-receive-only', 'session-end', 'session-end-replayed'].map(load));
  const session = created.response.body.session;
  assert.deepEqual(list.response.body.result.tools.map((tool) => tool.name), session.allowedTools, 'tools/list shows the minted session\'s tools');
  assert.ok(receiveOnly.response.body.session.allowedTools.every((name) => session.allowedTools.includes(name)), 'fewer permissions only narrow the tools');
  assert.deepEqual([endReplayed.request, endReplayed.response], [end.request, end.response], 'ending twice repeats the first ending');
  assert.equal(end.request.body.sessionId, session.id, 'the host ends the session it minted');

  const lost = await load('mint-lost-response-retry');
  const [firstMint, retryMint, oldUse, newUse] = lost.steps;
  assert.equal(firstMint.delivered, false, 'the first mint response was lost');
  assert.deepEqual(retryMint.request, firstMint.request, 'the retry is the identical request');
  assert.notEqual(retryMint.response.body.session.token, firstMint.response.body.session.token, 'each mint returns a new token');
  assert.equal(bearer(oldUse.request), `Bearer ${firstMint.response.body.session.token}`, 'the superseded token is the lost one');
  assert.equal(oldUse.response.body.reason, 'superseded', 'the lost session is superseded');
  assert.equal(bearer(newUse.request), `Bearer ${retryMint.response.body.session.token}`, 'the live token is the retried one');

  const claimLost = await load('claim-lost-response');
  const [lostClaim, idle, reclaimed, minted] = claimLost.steps;
  assert.equal(idle.response.body.nextAvailableAt, lostClaim.response.body.work.leaseExpiresAt, 'the idle hint is the lost lease\'s expiry');
  assert.equal(reclaimed.response.body.work.workId, lostClaim.response.body.work.workId, 'the same work comes back');
  assert.notEqual(reclaimed.response.body.work.leaseToken, lostClaim.response.body.work.leaseToken, 'under a new lease');
  assert.equal(minted.request.body.leaseToken, reclaimed.response.body.work.leaseToken, 'the session is minted for the new lease');
  assert.ok(minted.response.body.session.fence > session.fence, 'with a higher fence');

  for (const name of ['reclaim-after-agent-resume', 'reclaim-after-case-resume', 'reclaim-after-reconnect']) {
    const fixture = await load(name);
    const [oldEnded, claim, mint, oldAgain] = fixture.steps;
    const next = mint.response.body.session;
    assert.equal(bearer(oldEnded.request), `Bearer ${session.token}`, `${name}: the old session is session-created's`);
    assert.equal(bearer(oldAgain.request), bearer(oldEnded.request), `${name}: the old token is tried again`);
    assert.equal(oldAgain.response.body.reason, oldEnded.response.body.reason, `${name}: the old session keeps its recorded reason`);
    assert.equal(mint.request.body.leaseToken, claim.response.body.work.leaseToken, `${name}: minted for the reclaimed lease`);
    assert.equal(bearer(mint.request), bearer(claim.request), `${name}: by the host that claimed`);
    assert.equal(next.workId, session.workId, `${name}: the same work`);
    assert.equal(next.agentId, session.agentId, `${name}: the same agent identity`);
    assert.ok(next.fence > session.fence, `${name}: a higher fence`);
    assert.notEqual(next.token, session.token, `${name}: a new token`);
    assert.equal(next.installationId !== session.installationId, name === 'reclaim-after-reconnect', `${name}: only a reconnect changes the installation`);
  }

  // §3.1: the humanDecision claim and its session agree, and the session names the other agent, not the person.
  const [decisionClaim, decisionMint] = await Promise.all([load('claimed-human-decision'), load('session-created-human-decision')]);
  const decisionWork = decisionClaim.response.body.work;
  const decisionSession = decisionMint.response.body.session;
  assert.deepEqual(decisionClaim.request.body, {}, 'a humanDecision claim needs no acceptHumanInstructions');
  assert.equal(decisionMint.request.body.leaseToken, decisionWork.leaseToken, 'the session binds the claimed lease');
  assert.deepEqual([decisionSession.workId, decisionSession.caseId, decisionSession.workKind], [decisionWork.workId, decisionWork.message.caseId, 'human_decision'], 'the session is for the claimed decision');
  assert.deepEqual(decisionSession.counterparty, { kind: 'agent', address: decisionWork.message.counterpartyAddress }, 'the counterparty is the case\'s other agent');
  assert.equal(decisionWork.message.recipientAgentId, decisionSession.agentId, 'the decision is addressed to this agent');
  const shown = JSON.stringify(decisionMint.client.modelVisible);
  for (const value of [decisionWork.message.senderHumanId, decisionWork.message.requestId, decisionWork.message.policyEvaluationId, decisionWork.message.counterpartyAgentId]) assert.ok(!shown.includes(value), `model-visible values never include ${value}`);
  const late = await load('late-write-after-pause');
  assert.deepEqual(late.steps[1].request.body.params, late.steps[0].request.body.params, 'the late write is the identical call');
  const [status, rollback] = await Promise.all([load('agent-status-case-sessions'), load('rollback-flag-off')]);
  assert.equal(status.response.body.caseSessions.available, status.flags.ENVOI_CASE_SESSIONS_V1, 'caseSessions.available is the flag');
  assert.equal(rollback.steps.at(-1).response.body.caseSessions.available, rollback.flags.ENVOI_CASE_SESSIONS_V1, 'caseSessions.available is the flag after rollback');

  const handoff = (await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8')).split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const sectionStart = handoff.indexOf('\n## case-session v1');
  const section = handoff.slice(sectionStart, handoff.indexOf('\n## ', sectionStart + 1) === -1 ? undefined : handoff.indexOf('\n## ', sectionStart + 1));
  const table = section.slice(section.indexOf('| Group | Fixtures |'), section.indexOf('### 15.'));
  const listed = [...table.matchAll(/`([a-z0-9-]+)`/g)].map((match) => `${match[1]}.json`).sort();
  const index = await readJson(path.join(root, 'index.json'));
  assert.deepEqual(listed, [...index.contracts.find((contract) => contract.id === 'case-session').fixtures].sort(), 'the handoff lists exactly the registered fixtures');
});

// case-tools §3, §8 and §10: replays return the original, conflicts write nothing, cases never share a
// reference, and the handoff's fixture table lists exactly the registered fixtures.
test('case-tools fixtures agree across cases', async () => {
  const dir = path.join(root, 'case-tools');
  const load = (name) => readJson(path.join(dir, `${name}.json`));
  const result = (exchange) => parseToolText(exchange.response).result;
  const args = (exchange) => exchange.request.body.params.arguments;
  const [first, replayed, reclaimed, conflict, snapshot, paged] = await Promise.all(['reply-agent-work', 'reply-replayed', 'reply-replayed-after-reclaim', 'reply-idempotency-conflict', 'snapshot-agent-work', 'snapshot-older-page'].map(load));
  // §1, §5: the tool list is case-session's x-case-tools, and no input property names a scope.
  const [schemas, sessionSchemas] = await Promise.all([load('schemas'), readJson(path.join(root, 'case-session', 'schemas.json'))]);
  const toolShape = (tool) => ({ name: tool.name, needs: tool.needs, workKinds: tool.workKinds });
  assert.deepEqual(schemas['x-tools'].map(toolShape), sessionSchemas['x-case-tools'].map(toolShape), 'x-tools names, order, needs and work kinds equal case-session x-case-tools');
  for (const tool of schemas['x-tools'].filter((entry) => entry.inputSchema)) {
    for (const property of Object.keys(tool.inputSchema.properties || {})) assert.ok(!sessionSchemas['x-scope-fields'].includes(property), `${tool.name}: ${property} names a scope`);
  }
  assert.ok(!('inReplyTo' in args(first)), 'the first reply relies on the default inReplyTo');
  assert.equal(result(first).inReplyTo, result(snapshot).requestedResponse.ref, 'the default inReplyTo is the snapshot\'s requestedResponse');
  assert.deepEqual(args(replayed), args(first), 'the replay is the identical call');
  assert.deepEqual(result(replayed), { ...result(first), replayed: true }, 'a replay returns the original result');
  assert.notEqual(reclaimed.request.headers.authorization, first.request.headers.authorization, 'the reclaimed turn uses a new session');
  assert.deepEqual(result(reclaimed), { ...result(first), replayed: true }, 'a replay under a later session for the same work returns the original');
  const [conflicting, original] = conflict.steps;
  assert.equal(args(conflicting).idempotencyKey, args(first).idempotencyKey, 'the conflict reuses the key');
  assert.notEqual(args(conflicting).text, args(first).text, 'with different arguments');
  assert.deepEqual(args(original), args(first), 'the original call after the conflict');
  assert.deepEqual(result(original), { ...result(first), replayed: true }, 'still replays unchanged: the conflict wrote nothing');
  const lost = await load('reply-lost-response');
  assert.equal(lost.steps[0].delivered, false, 'the first response was lost');
  assert.deepEqual(args(lost.steps[1]), args(lost.steps[0]), 'the retry is the identical call');
  assert.deepEqual(result(lost.steps[1]), { ...result(lost.steps[0]), replayed: true }, 'the retry returns the committed message');
  assert.deepEqual(schemas['x-status-projection'].delivery.held, 'queued', 'a held message reads as queued');
  const [firstPage, olderPage] = paged.steps.map(result);
  const firstRefs = new Set(firstPage.recentEvents.map((event) => event.ref));
  assert.ok(olderPage.recentEvents.every((event) => !firstRefs.has(event.ref) && event.at <= firstPage.recentEvents[0].at), 'pages never overlap, and the older page is older');
  assert.equal(args(paged.steps[1]).eventsBefore, firstPage.page.olderCursor, 'the older page uses the first page\'s cursor');

  const [needsHuman, ask, decisionSnapshot, approvedAccept, awaiting] = await Promise.all(['authority-check-needs-human', 'request-human', 'snapshot-human-decision', 'decide-after-human-approval', 'snapshot-awaiting-decision'].map(load));
  const humanAuthority = result(needsHuman).authorityRef;
  assert.equal(args(ask).authorityRef, humanAuthority, 'the request names the needsHuman authority');
  assert.deepEqual([result(decisionSnapshot).authority.lastPolicyDecision.authorityRef, result(decisionSnapshot).authority.lastPolicyDecision.humanApproval], [humanAuthority, 'approved'], 'the decision work shows the approved authority');
  assert.equal(args(approvedAccept).authorityRef, humanAuthority, 'the resumed turn accepts under the approved authority');
  assert.equal(args(approvedAccept).optionRef, result(decisionSnapshot).authority.lastPolicyDecision.optionRef, 'and the approved option');
  assert.equal(result(decisionSnapshot).counterparty.kind, 'agent', 'the approving person is never the counterparty');
  assert.equal(result(awaiting).proposal.ref, args(approvedAccept).proposalRef, 'the same proposal throughout');
  // §14: replays, and a completed case leaves complete out of allowedActions.
  const [shareFirst, shareReplay, completeFirst, completeReplay, completed] = await Promise.all(['share-asset', 'share-asset-replayed', 'complete-case', 'complete-case-replayed', 'snapshot-completed'].map(load));
  assert.deepEqual(args(shareReplay), args(shareFirst), 'the share replay is the identical call');
  assert.deepEqual(result(shareReplay), { ...result(shareFirst), replayed: true }, 'a share replay returns the original grant');
  assert.deepEqual(args(completeReplay), args(completeFirst), 'the completion replay is the identical call');
  assert.deepEqual(result(completeReplay), { ...result(completeFirst), replayed: true }, 'a completion replay returns the original receipt');
  assert.ok(!result(completed).allowedActions.includes('envoi_case_complete'), 'a completed case cannot be completed again');
  assert.ok(result(completed).recentEvents.some((event) => event.kind === 'receipt'), 'the receipt is in the timeline');
  const iso = await load('two-cases-same-counterparty');
  const [snapA, snapB, replyB, replyA] = iso.steps;
  assert.notEqual(snapA.request.headers.authorization, snapB.request.headers.authorization, 'two sessions');
  const refsA = new Set(collectRefs(result(snapA)).concat(collectRefs(result(replyA))));
  const refsB = collectRefs(result(snapB)).concat(collectRefs(result(replyB)));
  assert.ok(refsB.every((value) => !refsA.has(value)), 'the two cases share no reference');
  assert.equal(args(replyA).idempotencyKey, args(replyB).idempotencyKey, 'the same key in both cases');
  assert.notEqual(result(replyA).messageRef, result(replyB).messageRef, 'is two different messages');
  assert.equal(result(replyA).replayed, false, 'and neither is a replay');
  const foreign = await load('reply-ref-not-found');
  assert.ok(refsB.includes(args(foreign).inReplyTo), 'the unresolved reference belongs to the other case');

  const handoff = (await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8')).split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const start = handoff.indexOf('\n## case-tools v1');
  const next = handoff.indexOf('\n## ', start + 1);
  const section = handoff.slice(start, next === -1 ? undefined : next);
  const tables = section.split('| Group | Fixtures |').slice(1).map((rest) => rest.split('\n\n')[0]);
  const listed = tables.flatMap((table) => [...table.matchAll(/`([a-z0-9-]+)`/g)].map((match) => `${match[1]}.json`)).sort();
  const index = await readJson(path.join(root, 'index.json'));
  assert.deepEqual(listed, [...index.contracts.find((contract) => contract.id === 'case-tools').fixtures].sort(), 'the handoff lists exactly the registered fixtures');
});
