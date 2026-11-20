import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateJson } from '../../../connector/store';
import { reselectHermesGateway } from '../../../hermes/reselect';
import { hermesHost, saveHermesScopedMode, selectScopedHermes } from '../../../hermes/scoped-runtime';
import { hermesJournalMatches, hermesProfileIdentity } from '../../../hermes/scoped-host';
import { defaultContinuationFlowPolicy } from '../../../hermes/continuation-plan';
import { glue, selected, byteDigest } from './v4-glue.mjs';
import { withAssemblyCleanup } from './assembly-copy.mjs';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('incident 1: actual SDK reselection commits the file consumed by v4; old connection assertion fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-offline-selection-')); roots.push(root);
  const home = path.join(root, 'profile'), cwd = path.join(home, 'workspace'), directory = path.join(root, 'enrollment');
  await mkdir(cwd, { recursive: true }); await mkdir(directory);
  const configPath = path.join(home, 'config.yaml'); await writeFile(configPath, 'model:\n  default: synthetic\n');
  const origin = 'https://envoi.example', nextOrigin = 'http://127.0.0.1:18974';
  const config = { home, profile: 'default', configPath, apiUrl: 'http://127.0.0.1:18973', apiKey: '', scopedTools: true as const,
    daemonOrigin: 'http://127.0.0.1:18973', scopedCwd: cwd };
  const agent = { id: 'agent_synthetic', address: 'synthetic@envoi.example' };
  const installation = { id: 'installation_synthetic', agentId: agent.id, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', legacy: false };
  const session = { agentId: agent.id, inboxId: 'inbox_synthetic', address: agent.address, lifecycle: { state: 'STOPPED' },
    _onboarding: { completionId: 'completion_synthetic', origin, runtime: { type: 'hermes' }, agent, installation } };
  const connection = { version: 1, apiUrl: origin, runtime: 'hermes', address: agent.address, configuration: config,
    activationSetup: { completionId: 'completion_synthetic', installationId: installation.id, agentId: agent.id, inboxId: session.inboxId } };
  await privateJson(path.join(directory, 'connection.json'), connection);
  await privateJson(path.join(directory, 'session.json'), session);
  await privateJson(path.join(directory, 'helper-state.json'), { version: 1, phase: 'completed', completionId: 'completion_synthetic', origin, runtime: { type: 'hermes' } });
  await saveHermesScopedMode(directory, config);
  // Disposable sentinels model protected journals, accepted requests and ledgers.
  const protectedFiles = ['connection.json', 'session.json', 'helper-state.json', 'journal.json', 'accepted.json', 'ledger.json'];
  for (const file of protectedFiles.slice(3)) await writeFile(path.join(directory, file), '{"synthetic":"unchanged"}');
  const preserved = () => Promise.all(protectedFiles.map(file => readFile(path.join(directory, file), 'utf8')));
  const before = await preserved();
  const selectedConfig = await reselectHermesGateway(directory, origin, new AbortController().signal, { env: {},
    confirmGateway: async () => true, discoverGateway: async () => ({ home, cwd, origin: nextOrigin }) });
  const saved = JSON.parse(await readFile(path.join(directory, 'connection.json'), 'utf8'));
  expect(() => expect(saved.configuration.daemonOrigin).toBe(nextOrigin)).toThrow();
  expect(await glue().effectiveHermesSelection(directory, saved.configuration)).toEqual(selectedConfig);
  expect(await selectScopedHermes({ stateDir: directory, env: {} }, saved.configuration)).toEqual(selectedConfig);
  expect(await preserved()).toEqual(before);
  await writeFile(path.join(directory, 'hermes-scoped.json'), '{"version":99}');
  await expect(glue().effectiveHermesSelection(directory, saved.configuration)).rejects.toThrow('PERSONAL_NEW_ADDRESS_NOT_SAVED');
  await writeFile(path.join(directory, 'hermes-scoped.json'), 'broken');
  await expect(glue().effectiveHermesSelection(directory, saved.configuration)).rejects.toThrow();
});

it('incident 2: real SDK identity matches normalized host paths on Windows and POSIX', () => {
  const profile = path.join(tmpdir(), 'synthetic-profile', '..', 'synthetic-profile');
  const raw = profile + path.sep + '.', normalized = path.resolve(raw), cwd = path.join(normalized, 'workspace');
  const host = hermesHost({ home: normalized, profile: 'default', configPath: path.join(normalized, 'config.yaml'), apiUrl: 'http://127.0.0.1:18974',
    apiKey: '', scopedTools: true, daemonOrigin: 'http://127.0.0.1:18974', scopedCwd: cwd });
  const journal = { model: hermesProfileIdentity(host) };
  expect(hermesJournalMatches(journal as any, { ...host, home: raw })).toBe(false); // v3 spelling
  expect(hermesJournalMatches(journal as any, { ...host, home: path.resolve(raw) })).toBe(true);
  expect(hermesJournalMatches(journal as any, { ...host, cwd: cwd + '-foreign' })).toBe(false);
});

it('incident 4: composed v4 callback observes pre-native controls without binding an absent native target', async () => {
  const capture = vi.fn(async facts => { if (!Object.hasOwn(plan.flowCases, facts.flowId)) throw new Error('NATIVE_TARGET_ABSENT'); });
  const observe = vi.fn(async () => {}), plan = { flowCases: { openclaw: 'case_synthetic' } };
  const context = { probes: { observeScopedFacts: observe }, role: 'openclaw', ctx: { plan, targets: { captureScopedFacts: capture } },
    prepareFixture: async () => {}, fixtureHooks: undefined };
  const pre = { flowId: 'pre-native-control:synthetic', caseId: 'case_synthetic' };
  const old = glue({ scopeCallback: selected.segments.scopeCallback.source.replace("role==='openclaw'&&bindsNativeScope(ctx.plan,facts)", "role==='openclaw'") });
  await expect(old.scopeCallback(context)(pre)).rejects.toThrow('NATIVE_TARGET_ABSENT');
  capture.mockClear(); observe.mockClear();
  const callback = glue().scopeCallback(context);
  await callback(pre); expect(capture).not.toHaveBeenCalled(); expect(observe).toHaveBeenCalledWith(pre);
  const native = { ...pre, flowId: 'openclaw' }; await callback(native);
  expect(capture).toHaveBeenCalledExactlyOnceWith(native);
  expect(observe).toHaveBeenCalledTimes(2);
});

it('incident 8: corrected owner decline instruction names only its target; SDK requires no-action resumption', async () => {
  const messages: any[] = [];
  const c = { plan: { flowCases: { 'declined-resume': 'case_declined' } }, ownerInstructions: { post: async x => messages.push(x) } };
  await glue().conductor.announceHumanDecision.call(c, { nextFlow: 'declined-resume', outcome: 'declined' });
  const requireSafeInstruction = text => {
    expect(text).toContain('case_declined'); expect(text).toContain('Leave every other pending request untouched until you are asked.');
    expect(text).toContain('Do not send another task.');
  };
  expect(() => requireSafeInstruction(messages[0].text.replace('Leave every other pending request untouched until you are asked. ', ''))).toThrow();
  requireSafeInstruction(messages[0].text);
  expect(defaultContinuationFlowPolicy('declined-resume')).toEqual({ noAction: true, decisionOutcome: 'declined', allowHumanEnd: false });
});

it('unknown/malformed native responses refuse, while the real operator parser accepts a completed no-action response', () => {
  const api = glue(); expect(api.terminalResponses('{"status":"completed","output":[]}').status).toBe('completed');
  for (const response of ['garbage', '{}', '{"status":"unknown","output":[]}', '{"status":"completed","output":[{"type":"function_call"}]}'])
    expect(() => api.terminalResponses(response)).toThrow();
  for (const segment of Object.values(selected.segments) as any[]) expect(byteDigest(segment.source)).toBe(segment.sha256);
});

it.each([false, true])('assembled launcher retains the initiating failure and cleans up even when cleanup fails: %s', async cleanupFails => {
  const initial = Object.assign(new Error('SYNTHETIC_INITIATING_FAILURE'), { code: 'TIMEOUT' });
  const cleanupFailure = new Error('SYNTHETIC_CLEANUP_FAILURE'), cleanup = vi.fn(async () => { if (cleanupFails) throw cleanupFailure; });
  const stop = vi.fn(), ctx = { waitForOwnerGatewayReviews: async () => {}, cleanup };
  const result = glue().failureCleanup(ctx, { stop }, async () => { throw initial; });
  if (cleanupFails) await expect(result).rejects.toMatchObject({ errors: [initial, cleanupFailure] });
  else await expect(result).rejects.toBe(initial);
  expect(cleanup).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledExactlyOnceWith('ACTUAL_PROGRAM_FAILED');
});

it('the original-assembly transport guard refuses before native/network argument parsing', async () => {
  // Deliberately invalid arguments cannot connect even if a future guard breaks.
  const script = `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
    const operations=[()=>net.connect({port:-1}),()=>new net.Socket().connect({port:-1}),()=>tls.connect({port:-1}),
      ()=>http.request('not-a-url'),()=>https.request('not-a-url'),()=>fetch('not-a-url')];
    const codes=[];for(const operation of operations){try{await operation();codes.push('UNEXPECTED_SUCCESS');}catch(e){codes.push(e.code);}}
    console.log(JSON.stringify(codes));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', new URL('./transport-guard.mjs', import.meta.url).href,
    '--input-type=module', '-e', script], { windowsHide: true });
  expect(JSON.parse(stdout)).toEqual(Array(6).fill('OFFLINE_TRANSPORT_BLOCKED'));
});

it.each([false, true])('private assembly cleanup preserves its initiating error and diagnostics when cleanup fails: %s', async cleanupFails => {
  const initial = Object.assign(new Error('ORIGINAL_ASSEMBLY_TEST_FAILED: private diagnostic location'), { code: 'TIMEOUT' });
  const removal = new Error('SYNTHETIC_DIRECTORY_LOCKED');
  const cleanup = vi.fn(async () => { if (cleanupFails) throw removal; });
  const operation = withAssemblyCleanup(async () => { throw initial; }, cleanup);
  if (cleanupFails) await expect(operation).rejects.toMatchObject({ errors: [initial, removal], cause: initial, message: initial.message });
  else await expect(operation).rejects.toBe(initial);
  expect(cleanup).toHaveBeenCalledTimes(1);
});
