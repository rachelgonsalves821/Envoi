const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAX_SCAN_BYTES = 25 * 1024 * 1024;

export function clamdCommand(command) {
  if (!['PING', 'INSTREAM'].includes(command)) throw new TypeError('Unsupported ClamAV command');
  return encoder.encode(`z${command}\0`);
}

export function clamdChunk(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024) throw new TypeError('Invalid ClamAV chunk');
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, false);
  frame.set(bytes, 4);
  return frame;
}

export function parseClamdReply(bytes, command) {
  const reply = decoder.decode(bytes).replace(/\0+$/, '').trim();
  if (command === 'PING') {
    if (reply !== 'PONG') throw new Error('ClamAV did not confirm readiness');
    return { ready: true };
  }
  if (command !== 'INSTREAM') throw new TypeError('Unsupported ClamAV command');
  if (/^stream: OK$/.test(reply)) return { status: 'clean', engine: 'clamav', signature: null };
  const infected = /^stream: (.+) FOUND$/.exec(reply);
  if (infected) return { status: 'infected', engine: 'clamav', signature: infected[1] };
  throw new Error('ClamAV returned an invalid scan result');
}

export async function readBoundedBody(body, maxBytes = MAX_SCAN_BYTES) {
  if (!body) throw new TypeError('A scan body is required');
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new RangeError('Scan body exceeds the size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function matchesSha256Base64(bytes, claimed) {
  if (typeof claimed !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(claimed)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...digest)) === claimed;
}
