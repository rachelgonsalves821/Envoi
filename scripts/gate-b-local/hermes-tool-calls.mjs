// Print the tool calls a Hermes profile's chats made: tool name and command or URL arguments only, never tool output.
// Use it for rows 3, 4 and 11 ("what did the chat actually run?"). Needs Node 22+ (node:sqlite).
//   node scripts/gate-b-local/hermes-tool-calls.mjs %LOCALAPPDATA%\hermes\profiles\<profile>\state.db [--since <unix seconds>]
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const sinceIndex = process.argv.indexOf('--since');
const since = sinceIndex > 0 ? Number(process.argv[sinceIndex + 1]) : 0;
const redact = (v) => String(v).replace(/[A-Za-z0-9_-]{32,}/g, '<LONG>').slice(0, 220);
let count = 0;
for (const row of db.prepare('select timestamp, tool_calls from messages where tool_calls is not null and timestamp >= ? order by timestamp').all(since)) {
  let calls;
  try { calls = JSON.parse(row.tool_calls); } catch { continue; }
  for (const call of Array.isArray(calls) ? calls : [calls]) {
    const fn = call.function ?? call;
    let args = fn.arguments ?? fn.args ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const shown = ['command', 'url', 'urls', 'name', 'tool_name'].filter((k) => args[k] !== undefined).map((k) => `${k}=${redact(JSON.stringify(args[k]))}`);
    console.log(new Date(row.timestamp * 1000).toISOString(), fn.name, shown.join(' '));
    count++;
  }
}
console.log('tool calls:', count);
