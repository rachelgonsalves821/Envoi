import { createHash } from 'node:crypto';
import { putSignedAsset, type ClientOptions } from '../../sdk/typescript/src/index';
import type { SinaloaConnector } from '../../sdk/typescript/src/connector';

export interface ShareCaseAssetOptions {
  connector: SinaloaConnector;
  caseId: string;
  recipientAgentId: string;
  recipientAddress: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Stable across retries of one logical file announcement. */
  idempotencyKey: string;
  text: string;
  fetch?: ClientOptions['fetch'];
}

/** Trusted host workflow: upload bytes, require a clean scan, grant, then announce the asset. */
export async function shareCaseAsset(options: ShareCaseAssetOptions) {
  if (!options.idempotencyKey || options.idempotencyKey.length > 160 || /[\x00-\x1f\x7f]/.test(options.idempotencyKey)) {
    throw new TypeError('A stable asset exchange idempotency key is required');
  }
  if (!options.caseId || !options.recipientAgentId || !options.recipientAddress || !options.text.trim() ||
      !(options.bytes instanceof Uint8Array) || options.bytes.byteLength === 0) {
    throw new TypeError('A case, recipient, nonempty text and file bytes are required');
  }
  const checksumSha256 = createHash('sha256').update(options.bytes).digest('base64');
  const begun = await options.connector.beginAssetUpload(`${options.idempotencyKey}:upload`, {
    filename: options.filename, mimeType: options.mimeType, size: options.bytes.byteLength,
    checksumSha256, caseId: options.caseId
  });
  await putSignedAsset(begun.upload, options.bytes, { fetch: options.fetch });
  const asset = await options.connector.completeAssetUpload(begun.object.id);
  if (asset.state !== 'clean' || asset.caseId !== options.caseId) {
    throw new Error('Asset was not cleared for this case');
  }
  const grant = await options.connector.grantCaseAsset(asset.id, options.recipientAgentId, `${options.idempotencyKey}:grant`);
  const message = await options.connector.sendCaseEvent(`${options.idempotencyKey}:announce`, {
    caseId: options.caseId, recipientEmail: options.recipientAddress, text: options.text,
    intent: 'message', artifactRefs: [asset.id]
  });
  return { asset, grant, message };
}
