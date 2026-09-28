import { expect, it, vi } from 'vitest';
import { subscribeReplayRecovery } from '../src/event-replay';

it('refreshes bounded replay notices while preserving native reconnect state', () => {
  const stream = new EventTarget();
  const close = vi.fn();
  Object.assign(stream, { close });
  const refresh = vi.fn(); const notify = vi.fn();
  const cleanup = subscribeReplayRecovery(stream, refresh, notify);
  stream.dispatchEvent(new Event('replay_required'));
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenCalledWith('Catching up on workspace activity…');
  expect(close).not.toHaveBeenCalled();
  cleanup();
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
});
