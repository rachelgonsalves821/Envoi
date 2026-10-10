import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isHumanInstructionMessage, type EnvoiConnector } from '../../sdk/typescript/src/connector';
import { shareCaseAsset } from './asset-exchange';
import type { AssetExchange } from './bridge';

export interface ApprovedAsset {
  handle: string;
  filename: string;
  mimeType: string;
  sha256: string;
  absolutePath: string;
}

const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** The host owner approves exact bytes. Model output can select a handle but cannot select a path or recipient. */
export async function loadAssetManifest(manifestPath: string | undefined): Promise<Map<string, ApprovedAsset>> {
  const approved = new Map<string, ApprovedAsset>();
  if (!manifestPath) return approved;
  const file = path.resolve(manifestPath);
  const root = await realpath(path.dirname(file));
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { files?: unknown }).files)
    || (parsed as { files: unknown[] }).files.length > 100) throw new Error('Invalid approved asset manifest');
  for (const item of (parsed as { files: unknown[] }).files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid approved asset entry');
    const value = item as Record<string, unknown>;
    if (typeof value.handle !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.handle) || approved.has(value.handle)
      || typeof value.path !== 'string' || path.isAbsolute(value.path) || typeof value.mimeType !== 'string'
      || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mimeType)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw new Error('Invalid approved asset entry');
    const absolutePath = await realpath(path.resolve(root, value.path));
    if (!within(root, absolutePath)) throw new Error('Approved asset must stay inside the manifest directory');
    approved.set(value.handle, { handle: value.handle, filename: path.basename(absolutePath),
      mimeType: value.mimeType, sha256: value.sha256.toLowerCase(), absolutePath });
  }
  return approved;
}

export function manifestAssetExchange(manifest: Map<string, ApprovedAsset>, connector: EnvoiConnector,
  exchange: typeof shareCaseAsset = shareCaseAsset): AssetExchange {
  return async (message, reply, idempotencyKey, signal) => {
    if (isHumanInstructionMessage(message)) throw new Error('Human instruction replies cannot target a native asset recipient');
    const entry = reply.assetHandle && manifest.get(reply.assetHandle);
    if (!entry || !message.caseId || !message.senderAgentId || !message.from?.address) throw new Error('Approved case asset and sender are required');
    if (signal.aborted) throw new Error('Work lease was interrupted');
    const currentPath = await realpath(entry.absolutePath);
    if (currentPath !== entry.absolutePath) throw new Error('Approved asset path changed');
    const bytes = await readFile(currentPath);
    if (!bytes.length || bytes.length > 25 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('Approved asset bytes changed or exceed the file limit');
    }
    if (signal.aborted) throw new Error('Work lease was interrupted');
    await exchange({ connector, caseId: message.caseId, recipientAgentId: message.senderAgentId,
      recipientAddress: message.from.address, filename: entry.filename, mimeType: entry.mimeType,
      bytes, idempotencyKey, text: reply.text });
  };
}
