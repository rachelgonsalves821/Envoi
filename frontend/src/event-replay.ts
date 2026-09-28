// Keep this EventSource instance alive: the browser carries Last-Event-ID when
// the server closes a bounded replay response and automatically reconnects.
export function subscribeReplayRecovery(stream: Pick<EventSource, 'addEventListener' | 'removeEventListener'>, refresh: () => void, notify: (message: string) => void) {
  const replayRequired = () => {
    notify('Catching up on workspace activity…');
    refresh();
  };
  stream.addEventListener('replay_required', replayRequired);
  return () => stream.removeEventListener('replay_required', replayRequired);
}
