import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { scopedAcpTransport } from './scoped-acp';

const server = { name: 'envoi_fixture', command: process.execPath, args: [], env: [] };
const source = String.raw`
import { createInterface } from 'node:readline';
const mode = process.argv[1];
const output = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'timeout') return;
    output({id:message.id,result:{protocolVersion:mode==='version'?2:1,agentInfo:{name:'hermes-agent'},agentCapabilities:{loadSession:true},echo:message.params}});
  } else if (message.method === 'session/load') {
    output({method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'restored'}}}});
    output({id:message.id,result:{}});
  } else if (message.method === 'session/prompt') {
    promptId=message.id;
    if (mode === 'oversize') { process.stdout.write(' '.repeat(1000001)); return; }
    if (mode === 'malformed') { process.stdout.write('private-not-json\n'); return; }
    if (mode === 'unknown-id') { output({id:99999,result:{private:'secret'}}); return; }
    if (mode === 'error') { output({id:message.id,error:{code:-32000,message:'private provider token'}}); return; }
    if (mode === 'exit') { process.exit(0); }
    if (mode === 'cancel') return;
    if (mode === 'wrong-session') {
      output({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'private'}}}}); return;
    }
    if (mode === 'permission' || mode === 'no-rejection') {
      output({id:'permission',method:'session/request_permission',params:{sessionId:message.params.sessionId,toolCall:{toolCallId:'one'},options:mode==='permission'?[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]:[{optionId:'allow',kind:'allow_always'}]}}); return;
    }
    if (mode === 'filesystem') { output({id:'filesystem',method:'fs/read_text_file',params:{sessionId:message.params.sessionId,path:'private'}}); return; }
    output({id:message.id,result:{stopReason:'end_turn',echo:message.params}});
  } else if (message.method === 'session/cancel') {
    output({id:promptId,result:{stopReason:'cancelled',echo:message.params}});
  } else if (message.id === 'permission' || message.id === 'filesystem') {
    output({id:promptId,result:{stopReason:'end_turn',clientReply:message}});
  }
});
`;

function fixture(mode = 'normal', timeoutMs = 3000) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, mode], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
  });
  const updates = vi.fn();
  const transport = scopedAcpTransport({ input: child.stdin, output: child.stdout }, { sessionId: 'bound-session', timeoutMs, onUpdate: updates });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr.resume();
  return { transport, updates,
    async ready() { await transport.initialize(); await transport.load(process.cwd(), [server]); },
    async close() { transport.close(); child.kill(); await exited; } };
}

describe('Hermes ACP transport using synthetic Node processes only', () => {
  it('negotiates no filesystem/terminal access and loads only the captured session', async () => {
    const item = fixture();
    try {
      const descriptor = await item.transport.initialize();
      expect(descriptor.echo).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      await item.transport.load(process.cwd(), [server]);
      expect(item.updates).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'restored' } });
      const result = await item.transport.prompt('Bound input');
      expect(result.echo).toEqual({ sessionId: 'bound-session', prompt: [{ type: 'text', text: 'Bound input' }] });
      expect(item.transport.active).toBe(true);
    } finally { await item.close(); }
  });

  it.each(['permission', 'no-rejection', 'filesystem'])('never grants a reverse %s request', async mode => {
    const item = fixture(mode);
    try {
      await item.ready();
      const result = await item.transport.prompt('Controlled turn');
      if (mode === 'permission') expect(result.clientReply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
      else if (mode === 'no-rejection') expect(result.clientReply).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
      else expect(result.clientReply).toMatchObject({ error: { code: -32601, message: 'Client capability unavailable' } });
    } finally { await item.close(); }
  });

  it.each(['oversize', 'malformed', 'unknown-id', 'error', 'exit', 'wrong-session'])('permanently closes on %s without leaking provider data', async mode => {
    const item = fixture(mode);
    try {
      await item.ready();
      await expect(item.transport.prompt('Controlled turn')).rejects.toThrow('Scoped ACP transport unavailable');
      expect(item.transport.active).toBe(false);
      await expect(item.transport.prompt('Never retry implicitly')).rejects.toThrow('Scoped ACP transport unavailable');
      expect(item.updates).toHaveBeenCalledTimes(1);
    } finally { await item.close(); }
  });

  it('cancels the captured prompt and waits for its correlated terminal result', async () => {
    const item = fixture('cancel');
    try {
      await item.ready();
      const prompt = item.transport.prompt('Wait until cancelled');
      await expect(item.transport.prompt('Concurrent prompt')).rejects.toThrow();
      item.transport.cancel();
      expect(await prompt).toEqual({ stopReason: 'cancelled', echo: { sessionId: 'bound-session' } });
    } finally { await item.close(); }
  });

  it('fails closed on initialization mismatch and deadline, with no implicit runtime restart', async () => {
    for (const mode of ['version', 'timeout']) {
      const item = fixture(mode, mode === 'timeout' ? 80 : 3000);
      try {
        await expect(item.transport.initialize()).rejects.toThrow('Scoped ACP transport unavailable');
        expect(item.transport.active).toBe(false);
      } finally { await item.close(); }
    }
  });

  it('rejects invalid host input without sending it or losing a valid session', async () => {
    const item = fixture();
    try {
      await expect(item.transport.prompt('Before initialization')).rejects.toThrow();
      await item.ready();
      await expect(item.transport.load(process.cwd(), [server])).rejects.toThrow();
      await expect(item.transport.prompt(' '.repeat(262145))).rejects.toThrow();
      expect(item.transport.active).toBe(true);
    } finally { await item.close(); }
  });

  it('suppresses a success when the transport closes before its awaiting caller resumes', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const transport = scopedAcpTransport({ input, output }, { sessionId: 'bound-session' });
    const operation = transport.initialize();
    const refused = expect(operation).rejects.toThrow('Scoped ACP transport unavailable');
    output.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'hermes-agent' }, agentCapabilities: { loadSession: true } } }) + '\n');
    transport.close();
    await refused;
  });

  it.each(['finish', 'close'] as const)('treats a clean input %s as terminal and suppresses subsequent updates', async event => {
    const input = new PassThrough(), output = new PassThrough();
    const updates = vi.fn();
    const transport = scopedAcpTransport({ input, output }, { sessionId: 'bound-session', onUpdate: updates });
    const initialization = transport.initialize();
    output.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'hermes-agent' }, agentCapabilities: { loadSession: true } } }) + '\n');
    await initialization;
    const loading = transport.load(process.cwd(), [server]);
    output.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }) + '\n');
    await loading;
    const prompt = transport.prompt('Pending controlled prompt');
    const rejected = expect(prompt).rejects.toThrow('Scoped ACP transport unavailable');
    if (event === 'finish') input.end(); else input.destroy();
    await rejected;
    expect(transport.active).toBe(false);
    output.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'bound-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late private output' } }
    } }) + '\n');
    expect(updates).not.toHaveBeenCalled();
  });

  it('refuses pipes already ended before attachment', async () => {
    const input = new PassThrough(), output = new PassThrough();
    input.end();
    const transport = scopedAcpTransport({ input, output }, { sessionId: 'bound-session' });
    expect(transport.active).toBe(false);
    await expect(transport.initialize()).rejects.toThrow('Scoped ACP transport unavailable');
  });
});
