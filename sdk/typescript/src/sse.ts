/** Streaming SSE decoder. Control frames never inherit a previous event ID. */
export interface EventFrame { type: string; id?: string; data: Record<string, unknown> }

export async function* eventFrames(response: Response, signal: AbortSignal, activity: () => void): AsyncGenerator<EventFrame> {
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Invalid event stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', type = 'message', id: string | undefined, data: string[] = [];
  let frameBytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      activity();
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error('Event stream frame is too large');
      while (true) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match || match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        frameBytes += line.length;
        if (frameBytes > 1_048_576) throw new Error('Event stream frame is too large');
        if (!line) {
          if (data.length) {
            const parsed: unknown = JSON.parse(data.join('\n'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid event stream data');
            yield { type, ...(id !== undefined ? { id } : {}), data: parsed as Record<string, unknown> };
          }
          type = 'message'; id = undefined; data = []; frameBytes = 0;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') type = value;
          if (field === 'data') data.push(value);
          if (field === 'id' && !value.includes('\0')) id = value;
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
