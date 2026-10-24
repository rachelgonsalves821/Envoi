import { describe, expect, it, vi } from 'vitest';
import { McpEventsHost } from './mcp-events-host';
import type { McpWakeClient } from './mcp-wake-client';
import type { McpEventHint } from './mcp-events-receiver';

function setup() {
  let now = Date.parse('2026-10-24T12:00:00Z');
  const client = { lifecycle: 'RUNNING', discoverEvents: vi.fn(async () => true), subscribe: vi.fn(async () => ({ id: 'evtsub_0f3a9c2e51b84d7aa6c1', cursor: '00000000000000000104', truncated: true, refreshBefore: '2026-10-31T12:00:00Z' })) };
  let state = { subscription: null as any, cursor: null as string | null };
  let hints: McpEventHint[] = [];
  const store = { read: async () => structuredClone(state), save: vi.fn(async value => { state = structuredClone(value); }), pending: async () => structuredClone(hints), processed: vi.fn(async id => { hints = hints.filter(hint => hint.eventId !== id); }) };
  const driver = { catchUp: vi.fn(async () => {}), processWorkOnce: vi.fn(async () => {}) };
  const host = new McpEventsHost(client as unknown as McpWakeClient, store, driver, async () => ({ name: 'envoi.work_available', arguments: {}, delivery: { mode: 'webhook', url: 'https://hooks.example/events', secret: 'private-secret-not-a-model-input' } }), { now: () => now });
  return { client, store, driver, host, advance: (ms: number) => { now += ms; }, hints: (value: McpEventHint[]) => { hints = value; } };
}
const hint = (id: string, cursor: string): McpEventHint => ({ eventId: id, name: 'envoi.work_available', timestamp: '2026-10-24T12:00:00Z', data: { reason: 'message_delivered' }, cursor });
describe('private MCP events host catch-up and recovery', () => {
  it('claims after subscribe and delta-recovers truncation, then safety polls with no new hint', async () => {
    const test = setup(); await test.host.tick();
    expect(test.driver.catchUp).toHaveBeenCalledWith('00000000000000000104', true);
    expect(test.driver.processWorkOnce).toHaveBeenCalledOnce();
    await test.host.tick(); expect(test.driver.processWorkOnce).toHaveBeenCalledOnce();
    test.advance(60000); await test.host.tick(); expect(test.driver.processWorkOnce).toHaveBeenCalledTimes(2);
  });
  it('keeps failed hints pending for restart and never rewinds an out-of-order cursor', async () => {
    const test = setup(); await test.host.tick();
    test.hints([hint('first', '00000000000000000106'), hint('older', '00000000000000000105')]);
    test.driver.processWorkOnce.mockRejectedValueOnce(new Error('canonical server unavailable'));
    await expect(test.host.tick()).rejects.toThrow('canonical server unavailable');
    expect(test.store.processed).not.toHaveBeenCalled();
    await test.host.tick();
    expect((await test.store.read()).cursor).toBe('00000000000000000106');
    expect(await test.store.pending()).toEqual([]);
  });
  it('coalesces overlapping ticks and cannot resume a paused/revoked host by a retry timer', async () => {
    const test = setup(); await Promise.all([test.host.tick(), test.host.tick()]);
    expect(test.client.subscribe).toHaveBeenCalledOnce();
    test.client.lifecycle = 'PAUSED'; test.advance(900000); await test.host.tick();
    expect(test.driver.processWorkOnce).toHaveBeenCalledOnce();
    test.client.lifecycle = 'RUNNING'; test.host.stop(); await test.host.tick();
    expect(test.driver.processWorkOnce).toHaveBeenCalledOnce();
  });
  it('does not register subscriptions or claim when the protocol capability is absent', async () => {
    const test = setup(); test.client.discoverEvents.mockResolvedValue(false);
    await expect(test.host.tick()).rejects.toMatchObject({ code: 'EVENTS_UNAVAILABLE' });
    expect(test.client.subscribe).not.toHaveBeenCalled(); expect(test.driver.processWorkOnce).not.toHaveBeenCalled();
  });
});
