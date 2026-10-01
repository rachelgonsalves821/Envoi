import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnrollmentDialog } from '../src/App';
import { api } from '../src/api';
import { connectorDownloads, setupPrompt, suggestedAgentAddress, watchEnrollmentStatus, type EnrollmentStatus } from '../src/quick-connect';
import type { Inbox } from '../src/types';
import type { QuickConnectHandoff } from '../../sdk/typescript/src/quick-connect';

const handoff: QuickConnectHandoff = { version: 1, runtime: 'openclaw', apiUrl: 'https://sinaloa.example',
  enrollmentToken: 'one_time_token_1234567890', expiresAt: '2099-01-01T00:15:00Z', agentName: 'Potato', address: 'potato@agents.sinaloa.example' };
const status = (phase: EnrollmentStatus['phase']): EnrollmentStatus => ({ enrollmentId: 'enrollment_1', phase, expiresAt: '2099-01-01T00:15:00Z' });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Quick Connect handoff', () => {
  it('gives the runtime private-file setup instructions without passing secrets in command arguments', () => {
    const prompt = setupPrompt({ ...handoff, gatewayToken: 'provider_secret_should_not_be_sent' } as QuickConnectHandoff);
    expect(prompt).toContain('node sinaloa-openclaw.mjs setup --handoff sinaloa-setup.json');
    expect(prompt).toContain('artifacts["sinaloa-openclaw.mjs"].sha256');
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
    expect(connectorDownloads(handoff)).toEqual({ connector: 'https://sinaloa.example/web/downloads/sinaloa-openclaw.mjs', release: 'https://sinaloa.example/web/downloads/release.json' });
    expect(() => connectorDownloads({ ...handoff, apiUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => connectorDownloads({ ...handoff, apiUrl: 'https://user:secret@sinaloa.example' })).toThrow();
  });

  it.each([['Potato', 'potato'], ['Écho scheduler', 'echo-scheduler'], ['123 assistant', 'agent-123-assistant'], ['Admin', 'admin-agent'], ['AI', 'ai-agent'], ['', '']])('suggests an editable address for %s', (name, address) => {
    expect(suggestedAgentAddress(name)).toBe(address);
  });

  it('makes the prompt primary while preserving advanced setup and honest runtime verification', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, { workspace: { id: 'inbox_1' } as Inbox,
      result: { enrollmentId: 'enrollment_1', enrollmentToken: handoff.enrollmentToken, enrollmentUrl: '/?enroll=secret', expiresAt: handoff.expiresAt,
        agentProfile: { name: handoff.agentName, localPart: 'potato' }, quickConnect: handoff }, setResult: vi.fn(), onClose: vi.fn() }));
    expect(markup).toContain('Copy setup prompt');
    expect(markup).toContain(`value="${handoff.address}"`);
    expect(markup).toContain('Waiting for your agent');
    expect(markup).toContain('Download setup file');
    expect(markup).toContain('Terminal fallback');
    expect(markup).toContain('Advanced setup');
    expect(markup).toContain('Enrollment alone does not confirm');
    expect(markup).not.toContain('/?enroll=secret');
    expect(markup).not.toContain('I’ve copied the token');
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

  it('bounds repeated transient failures', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    const monitor = watch(request, { maxDurationMs: 10_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(monitor.onTimeout).toHaveBeenCalledTimes(1);
  });
});
