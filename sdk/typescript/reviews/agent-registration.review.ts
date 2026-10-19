import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../../integrations/contract-fixtures/setup';
import { EnvoiConnector, type ConnectorSession } from '../src/connector';
import { request, setCsrfCookieName, setExpectedHuman, SESSION_EXPIRED_EVENT } from '../../../frontend/src/api';

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'agent-registration' && item.version === 1);
if (!contract?.schemas) throw new Error('Set ENVOI_CONTRACT_FIXTURES_ROOT to the canonical agent-registration v1 publication');
const fixtures = contract.fixtures.map(file => loadContractFixture(contract, file, source) as any);
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const validator = (name: string) => {
  const [contractId, definition] = name.includes('/') ? name.split('/') : ['agent-registration', name];
  let schemaId = schemas.$id;
  if (contractId !== 'agent-registration') {
    const dependency = loadContractRegistry(source).contracts.find(item => item.id === contractId);
    if (!dependency?.schemas) throw new Error('Missing schema contract: ' + contractId);
    const dependencySchema = loadContractFixture(dependency, dependency.schemas, source) as any;
    schemaId = dependencySchema.$id;
    if (!ajv.getSchema(schemaId)) ajv.addSchema(dependencySchema);
  }
  const check = ajv.getSchema(schemaId + '#/definitions/' + definition);
  if (!check) throw new Error('Missing schema: ' + name);
  return check;
};
const validate = (name: string, value: unknown) => {
  const check = validator(name);
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
};
const byId = (id: string) => {
  const found = fixtures.find(item => item.id === id);
  if (!found) throw new Error('Missing fixture: ' + id);
  return found;
};
const operations = (fixture: any) => fixture.steps ?? [fixture];
const modelKeys = [
  'schemaVersion', 'state', 'reachability', 'nextAction', 'claimUrl', 'verificationCode',
  'expiresInSeconds', 'registrationStatus', 'workspaceName', 'agentName', 'agentAddress',
  'agentStatus', 'permissionSummary', 'connectionRoute', 'deliveryMode', 'guidance', 'approverEmailHint'
];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  setExpectedHuman(null); setCsrfCookieName();
});

describe('agent-registration v1 independent client consumption', () => {
  it('loads all 79 unique registered fixtures without copies and pins security/recovery limits', () => {
    expect(fixtures).toHaveLength(79);
    expect(new Set(fixtures.map(item => item.id)).size).toBe(79);
    expect(schemas['x-limits']).toMatchObject({
      registrationTtlSeconds: 600, activationWindowSeconds: 600, activationRecoverySeconds: 300,
      pollAfterSeconds: 5, pollMinIntervalSeconds: 4, deleteRecordsAfterHours: 24, deleteRecordsByHours: 25, ownerClaimListMax: 20, ownerInstallationEndedMax: 5,
      registrationCreate: { perSourcePerHour: 10, perNetworkPerHour: 30, perWideNetworkPerHour: 100, pendingGlobalMax: 1000, maxBodyBytes: 4096, durable: true },
      claimFailures: { perHuman: 5, windowSeconds: 900, durable: true }, approvalsAwaitingActivationPerHuman: 3
    });
    expect([...Object.keys(schemas['x-model-visible'].serverDerived), ...Object.keys(schemas['x-model-visible'].helperDerived)].sort()).toEqual([...modelKeys].sort());
  });

  it.each(fixtures)('consumes $id declared schemas, surface policy and model-visible values', fixture => {
    validate('fixture', fixture);
    for (const step of operations(fixture)) {
      const { request: req, response, client } = step;
      validate(response.schema, response.body);
      if (req.schema) validate(req.schema, req.body);
      if (req.invalidAgainst) {
        const check = validator(req.invalidAgainst);
        expect(check(req.body)).toBe(false);
        expect(check.errors?.some(error => error.keyword === req.invalidBecause.keyword && error.instancePath === req.invalidBecause.instancePath)).toBe(true);
      }
      if (response.body.code) {
        const code = response.body.code;
        expect(response.body.error).toBe(code);
        const row = schemas['x-codes'][code];
        expect(response.status).toBe(row.status);
        const policy = row.bySurface[client.surface];
        expect(policy).toBeDefined();
        expect(client).toMatchObject({
          lifecycle: policy.lifecycle, retry: policy.retry,
          guidance: policy.guidanceByHelperState?.[client.helperState] ?? policy.guidanceByReason?.[response.body.reason] ?? policy.guidance
        });
        if (code === 'RATE_LIMITED') expect(Number(response.headers['retry-after'])).toBe(response.body.retryAfterSeconds);
      }
      if (req.auth === 'human_session' && req.method === 'POST') {
        expect(req.headers.origin).toBe('https://www.envoi-agents.com');
        expect(req.headers.cookie).toContain('envoi_session=');
        expect(req.headers.cookie).toContain('envoi_csrf=' + req.headers['x-envoi-csrf']);
      }
      if (client.surface === 'owner_ui') expect(JSON.stringify(response.body)).not.toMatch(/envoi_(?:reg|agent_access|agent_refresh|mcp_read|enroll)_/);
      if (!client.modelVisible) continue;
      const visible = client.modelVisible;
      for (const key of Object.keys(visible)) expect(modelKeys).toContain(key);
      expect(JSON.stringify(visible)).not.toMatch(/envoi_(?:reg|agent_access|agent_refresh|mcp_read|enroll)_|registration_example|installation_example|agent_example|inbox_example/);
      const body = response.body;
      for (const [key, value] of Object.entries(visible)) {
        if (key === 'claimUrl') expect(value).toBe(body.claim.url);
        if (key === 'verificationCode') { expect(body.status).toBe('pending_claim'); expect(value).toBe(body.claim.verificationCode); }
        if (key === 'registrationStatus') expect(value).toBe(response.schema === 'activated' ? 'activated' : body.status);
        if (key === 'approverEmailHint') expect(value).toBe(body.approverEmailHint);
        if (key === 'workspaceName') expect(value).toBe(body.workspaceName);
        if (key === 'agentName') expect(value).toBe(body.agent.name);
        if (key === 'agentAddress') expect(value).toBe(body.agent.address);
        if (key === 'agentStatus') expect(value).toBe(body.agent.status);
        if (key === 'permissionSummary') expect(value).toEqual(body.effectivePermissions.map((permission: string) => schemas['x-permission-labels'][permission]));
        if (key === 'connectionRoute') expect(value).toBe(body.installation.connectionRoute);
        if (key === 'deliveryMode') expect(value).toBe(body.installation.deliveryMode);
        if (key === 'guidance') expect(value).toBe(client.guidance);
      }
      if (visible.state === 'connected') expect(response.schema).toBe('agentStatusWithInstallation');
      if (visible.reachability) expect(visible.reachability).toBe('not_verified_closed_app');
    }
  });

  it.each(['routes-disabled', 'routes-available', 'routes-available-rest'])('%s offers only v1-supported routes and envoi_link', id => {
    const fixture = byId(id); const flags = fixture.flags; const body = fixture.response.body;
    const enabled = flags.ENVOI_AGENT_REGISTRATION_V2 && flags.ENVOI_INSTALLATIONS_V2;
    expect(body.routes.map((route: any) => route.connectionRoute)).toEqual(['local_helper', 'remote_mcp_oauth', 'provider_connector', 'authenticated_rest']);
    expect(body.deliveryModes.map((mode: any) => mode.deliveryMode)).toEqual(['envoi_link', 'webhook', 'provider', 'poll', 'on_demand', 'a2a']);
    expect(body.routes.filter((route: any) => route.available).map((route: any) => route.connectionRoute)).toEqual(!enabled ? [] : flags.ENVOI_AUTHENTICATED_REST_ROUTE ? ['local_helper', 'authenticated_rest'] : ['local_helper']);
    expect(body.deliveryModes.filter((mode: any) => mode.available).map((mode: any) => mode.deliveryMode)).toEqual(enabled ? ['envoi_link'] : []);
  });

  it.each(['claim-approve-new-agent', 'claim-approve-existing-agent'])('%s intersects permissions and keeps credentials away from the browser', id => {
    const fixture = byId(id);
    const effective = fixture.request.body.grantedPermissions.filter((permission: string) => fixture.context.requestedPermissions.includes(permission));
    if (!effective.includes('receive_agent_messages')) effective.push('receive_agent_messages');
    expect(fixture.response.body.effectivePermissions).toEqual(effective);
    expect('id' in fixture.response.body.agent).toBe(id === 'claim-approve-existing-agent');
    expect(fixture.response.body).not.toHaveProperty('agentApiToken');
    expect(fixture.response.body).not.toHaveProperty('agentRefreshToken');
    expect(fixture.response.body).not.toHaveProperty('bootstrapToken');
  });

  it.each([['activation-created', 'activation-recovered'], ['claim-approve-new-agent', 'claim-approve-replayed'], ['claim-reject', 'claim-reject-replayed'], ['claim-approve-new-agent', 'claim-approve-replayed-after-activation'], ['claim-withdraw', 'claim-withdraw-replayed']])('%s recovery/replay returns exactly the original %s body', (original, replay) => {
    expect(byId(replay).response.body).toEqual(byId(original).response.body);
    expect(byId(replay).request.body).toEqual(byId(original).request.body);
  });

  it('tombstones never instruct the helper to create a duplicate agent; replay differs from late recovery', () => {
    for (const id of ['activation-after-recovery-window', 'activation-recovery-expired', 'registration-poll-after-recovery-window']) {
      expect(byId(id).response.body.code).toBe('ACTIVATION_RECOVERY_EXPIRED');
      expect(byId(id).client).toMatchObject({ lifecycle: 'NEEDS_RECONNECT', retry: 'none', guidance: 'owner_reconnect' });
    }
    expect(byId('activation-replay').client).toMatchObject({ lifecycle: 'REVOKED', retry: 'none', guidance: 'owner_reconnect' });
    expect(byId('activation-created').client.lifecycle).toBe('ACTIVATING');
    expect(byId('agent-status-installation').client.lifecycle).toBe('CONNECTED');
    expect(byId('activation-paused-agent').response.body.agent.status).toBe('paused');
  });

  it('an approved poll requires local confirmation, with a server-derived approver hint', () => {
    const approved = byId('registration-approved');
    expect(approved.client).toMatchObject({ lifecycle: 'CONFIRMING', retry: 'none', modelVisible: { state: 'confirm_approval' } });
    expect(approved.response.body.approverEmailHint).toBe('o***@example.com');
    expect(approved.client.modelVisible).toMatchObject({
      approverEmailHint: approved.response.body.approverEmailHint,
      workspaceName: approved.response.body.workspaceName,
      agentName: approved.response.body.agent.name,
      agentAddress: approved.response.body.agent.address
    });
    expect(approved.client.modelVisible).not.toHaveProperty('verificationCode');
    expect(approved.client.next).toMatch(/confirm.*approver.*workspace.*agent.*permissions/i);
    const missingHint = structuredClone(approved.response.body);
    delete missingHint.approverEmailHint;
    expect(validator('registrationStatus')(missingHint)).toBe(false);
  });

  it('an unresolved activation with a deleted token asks the owner to check agents, never auto-registers', () => {
    const unresolved = byId('activation-token-invalid-unresolved');
    expect(unresolved.request.body).toEqual(byId('activation-created').request.body);
    expect(unresolved.client).toMatchObject({
      helperState: 'activation_unresolved', lifecycle: 'REGISTRATION_ENDED', retry: 'none',
      guidance: 'check_owner_agents', modelVisible: { state: 'registration_ended', guidance: 'check_owner_agents' }
    });
    const policy = schemas['x-codes'].REGISTRATION_TOKEN_INVALID.bySurface.helper;
    expect(policy.guidanceByHelperState.activation_unresolved).toBe('check_owner_agents');
    expect(byId('registration-token-invalid').client.guidance).toBe('register_again');
  });

  it('invalid activation preserves the approval and asks for a helper update', () => {
    const invalid = byId('activation-invalid');
    expect(invalid.response).toMatchObject({ status: 400, body: { code: 'ACTIVATION_INVALID' } });
    expect(invalid.client).toMatchObject({ lifecycle: 'UNCHANGED', retry: 'none', guidance: 'update_helper' });
    expect(invalid.request.invalidAgainst).toBe('activationRequest');
    expect(byId('claim-reject-after-approve').response.body.code).toBe('CLAIM_ALREADY_DECIDED');
  });

  it('co-managers are represented explicitly and the owner claim list admits 20 but rejects 21', () => {
    const claims = byId('owner-claims').response.body.claims;
    expect(claims.map((claim: any) => claim.approvedByMe)).toEqual([true, false, true]);
    expect(claims.map((claim: any) => claim.approvedAt)).toEqual(claims.map((claim: any) => claim.approvedAt).sort().reverse());
    const body = { claims: Array.from({ length: 20 }, (_, index) => ({
      ...claims[0], registrationId: 'registration_boundary_' + index
    })) };
    validate('ownerClaimList', body);
    body.claims.push({ ...claims[0], registrationId: 'registration_boundary_20' });
    expect(validator('ownerClaimList')(body)).toBe(false);
    const missingAttribution = structuredClone(claims[0]);
    delete missingAttribution.approvedByMe;
    expect(validator('ownerClaimList')({ claims: [missingAttribution] })).toBe(false);
  });

  it('restart fixtures preserve the approved unfrozen identity after an installation revoke', () => {
    const restart = byId('reconnect-after-installation-revoke');
    expect(restart.kind).toBe('restart');
    expect(restart.stored.agents[0]).toMatchObject({ onboardingStatus: 'approved', status: 'active' });
    expect(restart.steps[0].response.body.installations[0]).toMatchObject({ status: 'ended', endedReason: 'revoked' });
    const approval = restart.steps[1];
    expect(approval.request.body.target).toMatchObject({ kind: 'existing_agent', replacesInstallationId: null });
    expect(approval.response).toMatchObject({ status: 200, body: { target: 'existing_agent', agent: { id: restart.stored.agents[0].id } } });
  });

  it('the corrected canonical legacy projection keeps all active families and only five newest ended ones', () => {
    const fixture = byId('owner-installations-legacy-several');
    const rows = operations(fixture)[0].response.body.installations;
    expect(rows.filter((row: any) => row.status === 'active')).toHaveLength(2);
    expect(rows.filter((row: any) => row.status === 'ended')).toHaveLength(5);
    expect(rows).toHaveLength(7);
    expect(schemas.definitions.ownerInstallationList.properties.installations).not.toHaveProperty('maxItems');
    expect(fixture.stored.credentialFamilies.filter((family: any) => family.revokedAt)).toHaveLength(6);
    for (const state of ['active', 'ended']) {
      const times = rows.filter((row: any) => row.status === state).map((row: any) => state === 'active' ? row.activatedAt : row.endedAt);
      expect(times).toEqual([...times].sort().reverse());
    }
    validate('ownerInstallationList', legacyList(25));
  });

  it('all four bootstrap no-access probes preserve helper semantics, not connector refresh semantics', () => {
    for (const fixture of fixtures.filter(item => item.id.startsWith('bootstrap-'))) {
      expect(fixture.request.headers.authorization).toMatch(/^Bearer envoi_reg_/);
      expect(fixture.response).toMatchObject({ status: 401, body: { code: 'AUTHENTICATION_REQUIRED' } });
      expect(fixture.client).toMatchObject({ surface: 'helper', lifecycle: 'UNCHANGED', retry: 'none' });
    }
    expect(schemas['x-codes'].AUTHENTICATION_REQUIRED.bySurface.connector.retry).toBe('refresh_then_retry_once');
  });

  it('rollback removes only the installation projection from status and leaves recovery/claim routes unavailable', () => {
    const fixture = byId('rollback-flags-off');
    expect(fixture.steps[0].response.body).not.toHaveProperty('installation');
    expect(fixture.steps[0].response.body.state).toBe('active');
    expect(fixture.steps[1].response).toMatchObject({ status: 404, body: { code: 'FEATURE_DISABLED' } });
    const reenabling = byId('reenable-after-rollback').steps[0].response.body.installations;
    expect(reenabling.map((installation: any) => [installation.status, installation.endedReason, installation.legacy])).toEqual([['active', null, true], ['ended', 'replaced', false]]);
  });

  it.each(['agent-status-installation', 'rollback-flags-off'])('the real SDK accepts %s without interpreting installation status as presence', async id => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T12:05:00.000Z'));
    const activated = byId('activation-created').response.body;
    let session: ConnectorSession = {
      agentId: activated.agent.id, inboxId: activated.inboxId, address: activated.agent.address,
      agentApiToken: activated.agentApiToken, agentRefreshToken: activated.agentRefreshToken,
      agentTokenExpiresAt: activated.agentTokenExpiresAt, agentRefreshTokenExpiresAt: activated.agentRefreshTokenExpiresAt
    };
    const status = id === 'rollback-flags-off' ? byId(id).steps[0].response.body : byId(id).response.body;
    const fetcher = vi.fn().mockResolvedValue(Response.json(status));
    const connector = new EnvoiConnector('https://www.envoi-agents.com', {
      load: async () => session, save: async next => { session = next; }
    }, { fetch: fetcher });
    await connector.checkStatus();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://www.envoi-agents.com/api/agent/status');
    expect(fetcher.mock.calls[0][1].credentials).toBe('omit');
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe('Bearer ' + activated.agentApiToken);
    expect((await connector.lifecycle()).state).toBe('RUNNING');
  });

  it('the real frontend routes the canonical inadmissible-human 401 to sign-in', async () => {
    const fixture = byId('claim-not-admitted');
    const browser = new EventTarget(); const expired = vi.fn();
    browser.addEventListener(SESSION_EXPIRED_EVENT, expired); vi.stubGlobal('window', browser);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(fixture.response.body, { status: 401 })));
    await expect(request(fixture.request.path, { method: fixture.request.method, body: JSON.stringify(fixture.request.body) })).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(expired).toHaveBeenCalledTimes(1);
  });
});

// Handoff §6.5: every active legacy family must be visible, followed by <=5 ended.
// Construct only in memory from shared migration fixtures; never copy or edit them.
export function legacyList(activeCount: number) {
  const samples = byId('migration-legacy-family').steps[0].response.body.installations;
  const id = (n: number) => 'installation_legacy_00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  return {
    agentId: 'agent_example',
    installations: [
      ...Array.from({ length: activeCount }, (_, index) => ({ ...samples[0], id: id(index + 1) })),
      ...Array.from({ length: 5 }, (_, index) => ({
        ...samples[1], id: id(activeCount + index + 1),
        endedAt: new Date(Date.parse(samples[1].endedAt) - index * 86400000).toISOString()
      }))
    ]
  };
}

describe('legacy owner installation list cardinality', () => {
  it('accepts one active plus five ended legacy installations', () => {
    validate('ownerInstallationList', legacyList(1));
  });
  it('accepts all active legacy installations plus five ended, as handoff §6.5 requires', () => {
    const body = legacyList(2);
    for (const installation of body.installations) validate('installation', installation);
    expect(body.installations.filter(item => item.status === 'ended')).toHaveLength(5);
    expect(body.installations.filter(item => item.status === 'active')).toHaveLength(2);
    validate('ownerInstallationList', body);
  });
});
