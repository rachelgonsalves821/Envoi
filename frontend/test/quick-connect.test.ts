import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnrollmentDialog, RuntimePicker } from '../src/App';
import { api } from '../src/api';
import { RUNTIME_OPTIONS, connectorDownloads, dotsSetupPrompt, dotsSetupSkillFile, setupPrompt, setupSkillFile, suggestedAgentAddress, watchEnrollmentStatus, type EnrollmentStatus } from '../src/quick-connect';
import type { Inbox } from '../src/types';
import type { QuickConnectHandoff } from '../../sdk/typescript/src/quick-connect';

const handoff: QuickConnectHandoff = { version: 1, runtime: 'openclaw', apiUrl: 'https://envoi.example',
  enrollmentToken: 'one_time_token_1234567890', expiresAt: '2099-01-01T00:15:00Z', agentName: 'Potato', address: 'potato@agents.envoi.example' };
const status = (phase: EnrollmentStatus['phase']): EnrollmentStatus => ({ enrollmentId: 'enrollment_1', phase, expiresAt: '2099-01-01T00:15:00Z' });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Quick Connect handoff', () => {
  it('gives the runtime private-file setup instructions without passing secrets in command arguments', () => {
    const prompt = setupPrompt({ ...handoff, gatewayToken: 'provider_secret_should_not_be_sent' } as QuickConnectHandoff);
    expect(prompt).toContain('node envoi-connector.mjs setup --handoff envoi-setup.json');
    expect(prompt).toContain('artifacts["envoi-connector.mjs"].sha256');
    expect(prompt).toContain('using HTTP GET');
    expect(prompt).toContain('failed HEAD-only check');
    expect(prompt).toContain('0600');
    expect(prompt).toContain('remove the handoff file');
    expect(prompt).toContain('Setup exits after configuration and checks');
    expect(prompt).toContain('append --install-service');
    expect(prompt).toContain('existing process supervisor');
    expect(prompt).toContain('If multiple agents');
    expect(prompt).not.toContain('provider_secret_should_not_be_sent');
    const setup = JSON.parse(prompt.split('Setup data:\n')[1]);
    expect(setup).toEqual(handoff);
    expect(prompt.split('\n').find(line => line.startsWith('3. Run:'))).not.toContain(handoff.enrollmentToken);
  });

  it('uses the deployment origin for verified artifact downloads', () => {
    expect(connectorDownloads(handoff)).toEqual({ connector: 'https://envoi.example/web/downloads/envoi-connector.mjs', release: 'https://envoi.example/web/downloads/release.json' });
    expect(() => connectorDownloads({ ...handoff, apiUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => connectorDownloads({ ...handoff, apiUrl: 'https://user:secret@envoi.example' })).toThrow();
  });

  it('makes the downloaded connector skill match the selected runtime and one-use handoff', () => {
    const skill = setupSkillFile({ ...handoff, runtime: 'hermes' });
    expect(skill).toContain('name: envoi-hermes-setup');
    expect(skill).toContain(handoff.enrollmentToken);
    expect(skill).toContain('Delete it after setup');
    expect(skill).toContain('node envoi-connector.mjs setup --handoff envoi-setup.json --prepare-runtime');
  });

  it('offers native Dots setup without inventing a connector token or active address', () => {
    const prompt = dotsSetupPrompt('https://envoi.example', 'Milo', 'milo@agents.envoi.example');
    expect(prompt).toContain('https://envoi.example/mcp');
    expect(prompt).toContain('assigned only after approval');
    expect(prompt).toContain('turn on one native MCP Events monitor in this same run');
    expect(prompt).not.toContain(handoff.enrollmentToken);
    expect(dotsSetupSkillFile('https://envoi.example', 'Milo', 'milo@agents.envoi.example')).toContain(prompt);
    expect(() => dotsSetupPrompt('javascript:alert(1)', 'Milo', 'milo@agents.envoi.example')).toThrow();
  });

  it('guides a Dots reconnect through the existing OAuth identity', () => {
    const prompt = dotsSetupPrompt('https://envoi.example', 'Milo', 'milo@agents.envoi.example', true);
    expect(prompt).toContain('Reconnect an existing agent');
    expect(prompt).toContain('Milo (milo@agents.envoi.example)');
    expect(prompt).toContain('review the current installations');
    expect(prompt).toContain('Keep its existing address, cases and history');
    expect(prompt).not.toContain('request milo@agents.envoi.example as the agent address');
    expect(dotsSetupSkillFile('https://envoi.example', 'Milo', 'milo@agents.envoi.example', true)).toContain(prompt);
  });

  it.each(RUNTIME_OPTIONS)('provides the same setup flow for $label with isolated runtime-specific preparation', option => {
    const selected = { ...handoff, runtime: option.id };
    const prompt = setupPrompt(selected);
    expect(prompt).toContain(`self-hosted ${option.label} agent`);
    expect(prompt).toContain('envoi-connector.mjs');
    expect(prompt).toContain('Each enrollment needs its own private state directory');
    expect(prompt.includes('--prepare-runtime')).toBe(option.id === 'hermes');
    const picker = renderToStaticMarkup(createElement(RuntimePicker, { runtime: option.id, onChange: vi.fn() }));
    expect(picker).toContain(`checked="" value="${option.id}"`);
    expect(picker.match(/type="radio"/g)).toHaveLength(6);
    expect(picker.match(/disabled=""/g)).toHaveLength(3);
  });

  it('warns remote hosts about loopback and keeps reconnect identity instructions', () => {
    const prompt = setupPrompt({ ...handoff, runtime: 'hermes', operation: 'reconnect', apiUrl: 'http://127.0.0.1:8787' });
    expect(prompt).toContain('Reconnect this self-hosted Hermes');
    expect(prompt).toContain('remotely hosted agent cannot reach it');
    expect(prompt).toContain('retains the agent address and history');
    expect(prompt).toContain('generates or reuses the local key');
    expect(prompt).toContain('do not interrupt this session');
  });

  it('starts reconnect with the existing runtime selected', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, {
      workspace: { id: 'inbox_1' } as Inbox,
      reconnectAgent: { id: 'agent_1', name: 'Potato', address: handoff.address, runtime: 'hermes', status: 'active', onboardingStatus: 'approved' },
      result: null, setResult: vi.fn(), onClose: vi.fn()
    }));
    expect(markup).toContain('checked="" value="hermes"');
    expect(markup).toContain('Reconnect Potato');
    expect(markup.match(/<button class="button primary"/g)).toHaveLength(1);
    expect(markup).not.toContain('<details');
    expect(markup.match(/<input[^>]*value="dots"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('does not offer Dots OAuth reconnect for a frozen agent', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, {
      workspace: { id: 'inbox_1' } as Inbox,
      reconnectAgent: { id: 'agent_1', name: 'Potato', address: handoff.address, status: 'revoked', onboardingStatus: 'revoked' },
      result: null, setResult: vi.fn(), onClose: vi.fn()
    }));
    expect(markup.match(/<input[^>]*value="dots"[^>]*>/)?.[0]).toContain('disabled');
    expect(markup).toContain('This agent cannot reconnect through OAuth');
  });

  it('sends selected runtime for enrollment and reconnect and validates returned handoffs', async () => {
    const response = { enrollmentToken: handoff.enrollmentToken, enrollmentUrl: '/?enroll=private', expiresAt: handoff.expiresAt, quickConnect: { ...handoff, runtime: 'hermes' } };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(response), { status: 201 })));
    vi.stubGlobal('fetch', fetchMock);
    await api.enrollmentToken('inbox_1', 'Potato', 'potato', ['receive_agent_messages'], 'hermes');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).runtime).toBe('hermes');
    await api.reconnectAgentToken('inbox_1', 'agent_1', 'hermes');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ runtime: 'hermes' });
  });

  it.each([['Potato', 'potato'], ['Écho scheduler', 'echo-scheduler'], ['123 assistant', 'agent-123-assistant'], ['Admin', 'admin-agent'], ['AI', 'ai-agent'], ['', '']])('suggests an editable address for %s', (name, address) => {
    expect(suggestedAgentAddress(name)).toBe(address);
  });

  it('keeps private handoff alternatives in a single closed disclosure', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, { workspace: { id: 'inbox_1' } as Inbox,
      result: { enrollmentId: 'enrollment_1', enrollmentToken: handoff.enrollmentToken, enrollmentUrl: '/?enroll=secret', expiresAt: handoff.expiresAt,
        agentProfile: { name: handoff.agentName, localPart: 'potato' }, quickConnect: handoff }, setResult: vi.fn(), onClose: vi.fn() }));
    expect(markup.match(/<button class="button primary"/g)).toHaveLength(1);
    const help = markup.match(/<details[^>]*>[\s\S]*?<\/details>/g);
    expect(help).toHaveLength(1);
    expect(help![0]).not.toMatch(/<details[^>]* open/);
    expect(help![0]).toMatch(/<textarea[^>]*readOnly/i);
    expect(help![0]).toContain('Download agent skill file');
    expect(help![0]).toContain('Download setup file');
    expect(help![0]).toContain('prepare --runtime openclaw');
    expect(help![0]).toContain(`value="${handoff.enrollmentToken}"`);
    expect(markup).not.toContain('/?enroll=secret');
  });

  it('reads scoped status through the human session without sending the enrollment secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(status('waiting')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await api.enrollmentStatus('inbox one', 'enrollment/1', controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/inboxes/inbox%20one/agent-enrollment-tokens/enrollment%2F1/status', expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }));
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('authorization')).toBe(false);
  });
});

describe('bounded enrollment progress', () => {
  function watch(request: (signal: AbortSignal) => Promise<EnrollmentStatus>, options: Partial<Parameters<typeof watchEnrollmentStatus>[0]> = {}) {
    const onStatus = vi.fn(), onError = vi.fn(), onTimeout = vi.fn();
    const stop = watchEnrollmentStatus({ enrollmentId: 'enrollment_1', expiresAt: handoff.expiresAt, request, onStatus, onError, onTimeout, ...options });
    return { stop, onStatus, onError, onTimeout };
  }

  it('stops after runtime setup checks pass', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(status('waiting')).mockResolvedValueOnce(status('enrolled')).mockResolvedValue(status('ready'));
    const monitor = watch(request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(monitor.onStatus.mock.calls.map(([value]) => value.phase)).toEqual(['waiting', 'enrolled', 'ready']);
    expect(monitor.onTimeout).not.toHaveBeenCalled();
  });

  it('can restart status checks after the host repairs a reported setup error', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(status('error')).mockResolvedValue(status('ready'));
    const failed = watch(request);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(failed.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
    failed.stop();
    const repaired = watch(request);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(repaired.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready' }));
    expect(repaired.onError).not.toHaveBeenCalled();
  });

  it('cancels an in-flight status request and ignores its later result when closed', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let resolve: ((value: EnrollmentStatus) => void) | undefined;
    const request = vi.fn().mockImplementation((value: AbortSignal) => { signal = value; return new Promise<EnrollmentStatus>(done => { resolve = done; }); });
    const monitor = watch(request);
    monitor.stop();
    expect(signal?.aborted).toBe(true);
    resolve?.(status('ready'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.onStatus).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allows an already-paired agent to finish after the one-time token expires', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(status('enrolled')).mockResolvedValue(status('ready'));
    const monitor = watch(request, { expiresAt: new Date(Date.now() - 1).toISOString() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.onStatus.mock.calls.map(([value]) => value.phase)).toEqual(['enrolled', 'ready']);
  });

  it('stops waiting after the token expires without redeeming it', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(status('waiting'));
    const monitor = watch(request, { expiresAt: new Date(Date.now() - 1).toISOString() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(monitor.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'expired' }));
  });

  it('stops after losing access instead of repeatedly fetching unauthorized status', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue({ status: 403 });
    const monitor = watch(request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(monitor.onError).toHaveBeenCalledWith(expect.stringContaining('Refresh your workspace'));
  });

  it('watches a 30-minute code and stops exactly five minutes after expiry', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const request = vi.fn().mockResolvedValue(status('enrolled'));
    const monitor = watch(request, { expiresAt });
    await vi.advanceTimersByTimeAsync(34 * 60_000 + 59_999);
    expect(request).toHaveBeenCalledTimes(420);
    expect(monitor.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(420);
  });

  it('bounds repeated transient failures even if the code has expired', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    const monitor = watch(request, { expiresAt: new Date(Date.now() - 290_000).toISOString() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(monitor.onTimeout).toHaveBeenCalledTimes(1);
  });

  it('checks once on request after automatic progress checks end', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(status('enrolled'));
    const monitor = watch(request, { expiresAt: new Date(Date.now() - 360_000).toISOString(), checkOnce: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(monitor.onStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'enrolled' }));
    expect(monitor.onTimeout).not.toHaveBeenCalled();
  });
});
