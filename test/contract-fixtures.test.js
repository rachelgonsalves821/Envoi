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
  assert.equal(client.retry, entry.retry, `${label}: retry for ${value.code}`);
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
          assert.equal(fixture.client.retry, entry.retry, `${label}: retry for ${value.code}`);
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
      if (schemas['x-model-visible']) checkAgentRegistration(fixture, schemas, check, validator, label);
      assert.doesNotMatch(JSON.stringify(fixture), /(?:(?:envoi|sinaloa)_agent_(?:access|refresh)_|(?:envoi|sinaloa)_mcp_read_|(?:envoi|sinaloa)_enroll_|envoi_reg_)(?!PLACEHOLDER)/, `${label}: tokens must be placeholders`);
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
