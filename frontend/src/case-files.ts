import { api, safeDownloadUrl } from './api';
import { assetDisplayName, canDownloadAsset } from './model';
import type { Asset } from './types';

function canonicalChecksum(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try { const bytes = atob(value); return bytes.length === 32 && btoa(bytes) === value; }
  catch { return false; }
}

export async function prepareCaseAssetDownload(inboxId: string, asset: Asset, lookup = api.downloadAsset) {
  if (!canDownloadAsset(asset)) throw new Error('Download remains locked until the file has a clean safety scan.');
  const response = await lookup(inboxId, asset.id);
  const current = response?.object;
  if (!current || current.id !== asset.id || current.caseId !== asset.caseId || !canDownloadAsset(current)) {
    throw new Error('This file changed or is no longer available. Refresh the conversation.');
  }
  if (asset.checksumSha256 !== undefined && (!canonicalChecksum(asset.checksumSha256)
    || current.checksumSha256 !== asset.checksumSha256)
    || current.checksumSha256 !== undefined && !canonicalChecksum(current.checksumSha256)) {
    throw new Error('The file fingerprint changed or is unavailable. Refresh the conversation.');
  }
  const download = response.download;
  if (!download || download.method !== 'GET' || download.headers && Object.keys(download.headers).length) {
    throw new Error('This download requires an unsupported browser transport.');
  }
  const url = typeof download.url === 'string' ? safeDownloadUrl(download.url) : null;
  if (!url) throw new Error('The storage provider returned an unsafe download address.');
  return { url, filename: assetDisplayName(current) };
}
