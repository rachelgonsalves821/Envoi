export const scopedMcpStdioSource = String.raw`
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
const maximum = 262144;
const connectionId = randomBytes(16).toString('hex');
let protocolVersion = '2025-11-25';
async function main() {
  const url = new URL(process.env.ENVOI_SCOPED_MCP_URL || '');
  const token = process.env.ENVOI_SCOPED_MCP_TOKEN || '';
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp'
    || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(token)) throw new Error();
  async function forward(line) {
    if (Buffer.byteLength(line) > maximum) throw new Error();
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'mcp-protocol-version': protocolVersion,
        'x-envoi-mcp-connection': connectionId },
      body: line
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    if (response.status === 204) return;
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 1000000) { await reader.cancel(); throw new Error(); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8');
    const reply = JSON.parse(text);
    if (!reply || Array.isArray(reply) || reply.jsonrpc !== '2.0') throw new Error();
    if (reply.result && typeof reply.result.protocolVersion === 'string') protocolVersion = reply.result.protocolVersion;
    if (!process.stdout.write(text + '\n')) await once(process.stdout, 'drain');
  }
  process.stdin.setEncoding('utf8');
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (line.trim()) await forward(line);
    }
    if (Buffer.byteLength(buffered) > maximum) throw new Error();
  }
  if (buffered.trim()) await forward(buffered);
}
main().catch(() => { process.stderr.write('Scoped MCP transport unavailable\n'); process.exitCode = 1; process.stdin.destroy(); });
`;
