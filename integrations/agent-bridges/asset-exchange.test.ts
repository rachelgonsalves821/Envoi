import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SinaloaConnector, WorkMessage } from '../../sdk/typescript/src/connector';
import { loadAssetManifest, manifestAssetExchange } from './asset-manifest';
import { bridgeHandler, parseAgentReply, type BridgeDecision } from './bridge';
import { shareCaseAsset } from './asset-exchange';

describe('trusted case asset exchange', () => {
  it('does not grant or announce a file that failed its scan', async () => {
    const grantCaseAsset = vi.fn();
    const sendCaseEvent = vi.fn();
    const connector = {
      beginAssetUpload: async () => ({ object: { id: 'asset_one' },
        upload: { method: 'PUT', url: 'https://storage.example.test/asset_one' } }),
      listAssets: async () => [],
      completeAssetUpload: async () => ({ id: 'asset_one', caseId: 'case_one', state: 'infected' }),
      grantCaseAsset, sendCaseEvent
    } as unknown as SinaloaConnector;
    await expect(shareCaseAsset({ connector, caseId: 'case_one', recipientAgentId: 'agent_peer',
      recipientAddress: 'peer@sinaloa.mail', filename: 'result.txt', mimeType: 'text/plain',
      bytes: new TextEncoder().encode('content'), idempotencyKey: 'case-file-one', text: 'Review this',
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch }))
      .rejects.toThrow('not cleared');
    expect(grantCaseAsset).not.toHaveBeenCalled();
    expect(sendCaseEvent).not.toHaveBeenCalled();
  });

  it('lets a model select only a host-approved exact file and reuses one key after a claim retry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sinaloa-approved-files-'));
    try {
      const bytes = Buffer.from('approved report');
      await writeFile(path.join(root, 'report.txt'), bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const manifestPath = path.join(root, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify({ files: [{ handle: 'report', path: 'report.txt', mimeType: 'text/plain', sha256 }] }));
      const manifest = await loadAssetManifest(manifestPath);
      const exchange = vi.fn(async () => ({ asset: { id: 'asset_one' }, grant: {}, message: {} })) as unknown as typeof shareCaseAsset;
      const callback = manifestAssetExchange(manifest, {} as SinaloaConnector, exchange);
      const message = { id: 'msg_one', caseId: 'case_one', senderAgentId: 'agent_peer', recipientAgentId: 'agent_host',
        from: { agentId: 'agent_peer', address: 'peer@agents.sinaloa-inbox.com' }, text: 'Please share report' } as WorkMessage;
      const reply = parseAgentReply('{"text":"Here is the report","intent":"message","assetHandle":"report"}');
      expect(reply).toMatchObject({ assetHandle: 'report' });
      const saved = new Map<string, BridgeDecision>();
      const turn = vi.fn(async () => reply);
      const handler = bridgeHandler({ admit: async () => {}, replyFor: async id => saved.get(id) || null,
        saveReply: async (id, decision) => { saved.set(id, decision); } }, turn, callback);
      const context = { signal: new AbortController().signal, reply: vi.fn() };
      await handler.process(message, context);
      await handler.process(message, context);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(context.reply).not.toHaveBeenCalled();
      expect(exchange).toHaveBeenCalledTimes(2);
      expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'case_one', recipientAgentId: 'agent_peer',
        recipientAddress: 'peer@agents.sinaloa-inbox.com', idempotencyKey: 'bridge:msg_one:asset:1', bytes }));
      await expect(callback(message, { text: 'No', intent: 'message', assetHandle: 'unknown' }, 'key', context.signal)).rejects.toThrow('Approved');
      await writeFile(path.join(root, 'report.txt'), Buffer.from('changed report'));
      await expect(callback(message, reply as Extract<BridgeDecision, { text: string }>, 'key', context.signal)).rejects.toThrow('bytes changed');
      expect(() => parseAgentReply('{"text":"bad","intent":"message","assetHandle":"../secret"}')).toThrow('invalid asset handle');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
