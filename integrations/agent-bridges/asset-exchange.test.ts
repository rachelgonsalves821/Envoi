import { describe, expect, it, vi } from 'vitest';
import type { SinaloaConnector } from '../../sdk/typescript/src/connector';
import { shareCaseAsset } from './asset-exchange';

describe('trusted case asset exchange', () => {
  it('does not grant or announce a file that failed its scan', async () => {
    const grantCaseAsset = vi.fn();
    const sendCaseEvent = vi.fn();
    const connector = {
      beginAssetUpload: async () => ({ object: { id: 'asset_one' },
        upload: { method: 'PUT', url: 'https://storage.example.test/asset_one' } }),
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
});
