import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

// case-session §5: the x-case-tools rows a permission set allows for one work kind, in table order.
const readPermissions = ['send_agent_messages', 'receive_agent_messages'];
const caseSessionTools = (schemas, permissions, workKind) => schemas['x-case-tools']
  .filter((tool) => tool.workKinds.includes(workKind) && (tool.needs === 'read' ? permissions.some((permission) => readPermissions.includes(permission)) : permissions.includes(tool.needs)))
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
      assert.equal(session.counterparty.kind === 'agent', session.workKind === 'agent_message', `${stepLabel}: counterparty kind follows the work kind`);
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
const internalIdPattern = /\b(?:case|msg|agent|inbox|installation|case_session|session|credential_family|asset|evt|event|policy_eval|policy_exec|option|proposal|work|human|org|receipt|action|conversation|registration|enrollment)_(?!action\b)[A-Za-z0-9-]{4,}/; // human_action is an event kind, not an id
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
    const effective = implemented.filter((name) => context.allowedTools.includes(name));
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
    for (const value of collectRefs(document.result)) assert.match(value, /^[mpoae]_[a-z2-7]{16}$/, `${stepLabel}: ${value} is a reference`);
    const { result } = document;
    if (name === 'envoi_case_snapshot') {
      const limit = args.eventLimit ?? limits.eventLimitDefault;
      assert.ok(result.recentEvents.length <= limit, `${stepLabel}: at most eventLimit events`);
      assert.ok(result.recentEvents.every((event, index, list) => index === 0 || list[index - 1].at <= event.at), `${stepLabel}: events oldest first`);
      assert.equal(result.page.hasOlder, result.page.olderCursor !== null, `${stepLabel}: olderCursor exactly when hasOlder`);
      assert.equal('requestedResponse' in result, !args.eventsBefore, `${stepLabel}: requestedResponse only on a first page`);
      assert.equal(result.counterparty.kind === 'agent', context.workKind === 'agent_message', `${stepLabel}: counterparty kind follows the work kind`);
      if (result.requestedResponse) {
        assert.equal(result.requestedResponse.from === 'your_human', context.workKind === 'human_instruction', `${stepLabel}: the work comes from your workspace exactly for an instruction`);
        checkText(result.requestedResponse.text, result.requestedResponse.truncated, limits.requestedTextMaxBytes, `${stepLabel}: requested text`);
        // §6.2: when the work message is in the page it shares requestedResponse's reference and carries no text.
        const workItem = result.recentEvents.find((event) => event.ref === result.requestedResponse.ref);
        if (workItem) assert.equal(workItem.text, null, `${stepLabel}: the work message's timeline item carries no text`);
      }
      // §1, §6.2: allowedActions is the effective set limited to the implemented tools, in x-tools order.
      assert.deepEqual(result.allowedActions, effective, `${stepLabel}: allowedActions`);
      assert.ok(bytes(JSON.stringify({ ...result, recentEvents: [] })) <= limits.fixedSectionsMaxBytes, `${stepLabel}: fixed sections within fixedSectionsMaxBytes`);
      for (const event of result.recentEvents) {
        // §6.3: your own messages carry a delivery status and nothing else does; instructions and receipts carry no intent.
        assert.equal(event.deliveryStatus !== null, event.actor === 'you' && messageKinds.includes(event.kind), `${stepLabel}: deliveryStatus exactly on your own messages`);
        if (['instruction', 'instruction_reply', 'receipt'].includes(event.kind)) assert.equal(event.intent, null, `${stepLabel}: ${event.kind} carries no intent`);
        if (event.kind === 'human_action') assert.equal(event.actor, 'your_human', `${stepLabel}: only your workspace's human actions are projected`);
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
      assert.equal(result.recipient.kind === 'agent', context.workKind === 'agent_message', `${stepLabel}: the recipient is the session counterparty`);
      assert.equal(result.status, context.workKind === 'agent_message' ? 'queued' : 'delivered', `${stepLabel}: queued for agent work, delivered for an instruction`);
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
        if (workMessage && workMessage.kind !== 'humanInstruction') {
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

  const late = await load('late-write-after-pause');
  assert.deepEqual(late.steps[1].request.body.params, late.steps[0].request.body.params, 'the late write is the identical call');
  const [status, rollback] = await Promise.all([load('agent-status-case-sessions'), load('rollback-flag-off')]);
  assert.equal(status.response.body.caseSessions.available, status.flags.ENVOI_CASE_SESSIONS_V1, 'caseSessions.available is the flag');
  assert.equal(rollback.steps.at(-1).response.body.caseSessions.available, rollback.flags.ENVOI_CASE_SESSIONS_V1, 'caseSessions.available is the flag after rollback');

  const handoff = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
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

  const handoff = await readFile(path.join(root, '..', '..', 'docs', 'architecture', 'agent-native-v2', 'handoffs.md'), 'utf8');
  const start = handoff.indexOf('\n## case-tools v1');
  const next = handoff.indexOf('\n## ', start + 1);
  const section = handoff.slice(start, next === -1 ? undefined : next);
  const table = section.slice(section.indexOf('| Group | Fixtures |'), section.indexOf('### 11.'));
  const listed = [...table.matchAll(/`([a-z0-9-]+)`/g)].map((match) => `${match[1]}.json`).sort();
  const index = await readJson(path.join(root, 'index.json'));
  assert.deepEqual(listed, [...index.contracts.find((contract) => contract.id === 'case-tools').fixtures].sort(), 'the handoff lists exactly the registered fixtures');
});
