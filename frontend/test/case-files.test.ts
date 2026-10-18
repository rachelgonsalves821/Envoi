import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { prepareCaseAssetDownload } from '../src/case-files';
import { AssetRow, FileItem } from '../src/App';
import { assetStateMeta, canDownloadAsset } from '../src/model';
import type { Asset } from '../src/types';

const asset = (changes: Partial<Asset> = {}): Asset => ({ id: 'asset_one', caseId: 'case_one', state: 'clean',
  filename: 'brief.txt', mimeType: 'text/plain', size: 42, checksumSha256: Buffer.alloc(32, 0xab).toString('base64'),
  createdByAgentId: 'agent_alice', createdAt: '2026-10-17T12:00:00Z', ...changes });
const lookup = (changes: Partial<Asset> = {}, download = { url: 'https://storage.example/private/signed', method: 'GET' as const }) =>
  vi.fn(async () => ({ object: asset(changes), download }));

describe('authenticated case file download preparation', () => {
  it('rechecks the current owner route for each download and preserves the bound file', async () => {
    const current = lookup();
    for (const inboxId of ['inbox_alice', 'inbox_bob']) {
      expect(await prepareCaseAssetDownload(inboxId, asset(), current)).toEqual({ url: 'https://storage.example/private/signed', filename: 'brief.txt' });
      expect(current).toHaveBeenLastCalledWith(inboxId, 'asset_one');
    }
    expect(current).toHaveBeenCalledTimes(2);
  });

  it.each(['quarantine', 'quarantined', 'scanning', 'infected', 'error', undefined, 'future_state', 'constructor'])('does not request download for scan state %s', async state => {
    const current = lookup();
    const value = asset({ state: state as Asset['state'] });
    expect(canDownloadAsset(value)).toBe(false);
    expect(assetStateMeta(value)).toHaveProperty('label');
    await expect(prepareCaseAssetDownload('inbox_alice', value, current)).rejects.toThrow('clean safety scan');
    expect(current).not.toHaveBeenCalled();
  });

  it.each([{ state: 'infected' }, { state: 'scanning' }, { id: 'asset_other' }, { caseId: 'case_other' },
    { state: 'clean', scan: { status: 'infected' } }])('rejects changed fresh metadata %j', async changes => {
    await expect(prepareCaseAssetDownload('inbox_alice', asset(), lookup(changes as Partial<Asset>)))
      .rejects.toThrow('changed or is no longer available');
  });

  it.each([Buffer.alloc(32, 0xcd).toString('base64'), undefined, 'not-a-checksum', 'ab'.repeat(32)])('rejects changed or missing fresh fingerprints %s', async checksumSha256 => {
    await expect(prepareCaseAssetDownload('inbox_alice', asset(), lookup({ checksumSha256 }))).rejects.toThrow('fingerprint');
  });

  it('treats Base64 fingerprints as case-sensitive and preserves legacy files without a recorded fingerprint', async () => {
    const original = asset().checksumSha256!;
    const changed = original[0].toUpperCase() + original.slice(1);
    expect(changed).not.toBe(original);
    await expect(prepareCaseAssetDownload('inbox_alice', asset(), lookup({ checksumSha256: changed }))).rejects.toThrow('fingerprint');
    await expect(prepareCaseAssetDownload('inbox_alice', asset({ checksumSha256: undefined }), lookup({ checksumSha256: undefined }))).resolves.toHaveProperty('url');
  });

  it.each(['javascript:alert(1)', 'data:text/plain,private', 'https://user:secret@storage.example/file', 'file:///private/file'])('rejects unsafe URL %s', async url => {
    await expect(prepareCaseAssetDownload('inbox_alice', asset(), lookup({}, { url, method: 'GET' }))).rejects.toThrow('unsafe download');
  });

  it.each([401, 403, 404, 423, 503])('preserves authenticated download denial %s without a fallback', async status => {
    const denied = Object.assign(new Error('Access denied'), { status });
    const current = vi.fn(async () => { throw denied; });
    await expect(prepareCaseAssetDownload('inbox_other', asset(), current)).rejects.toBe(denied);
    expect(current).toHaveBeenCalledExactlyOnceWith('inbox_other', 'asset_one');
  });

  it('refuses transport requirements the browser link cannot honor', async () => {
    const current = vi.fn(async () => ({ object: asset(), download: { url: 'https://storage.example/file', method: 'GET' as const, headers: { Authorization: 'private-token' } } }));
    await expect(prepareCaseAssetDownload('inbox_alice', asset(), current)).rejects.toThrow('unsupported browser transport');
  });

  it('does not treat contradictory scan records as clean', async () => {
    const value = asset({ scan: { status: 'error' } });
    expect(canDownloadAsset(value)).toBe(false);
    expect(assetStateMeta(value).label).toBe('Scan failed');
    await expect(prepareCaseAssetDownload('inbox_alice', value, lookup())).rejects.toThrow('clean safety scan');
  });
});

describe('owner file controls', () => {
  it.each([
    ['clean', 'Ready to download', true], ['quarantine', 'Quarantined', false], ['scanning', 'Scanning', false],
    ['infected', 'Blocked: infected', false], ['error', 'Scan failed', false], ['future', 'Safety status unavailable', false]
  ] as const)('both owner surfaces show truthful scan state %s', (state, label, downloadable) => {
    const value = asset({ state: state as Asset['state'] });
    const row = renderToStaticMarkup(createElement(AssetRow, { asset: value, inboxId: 'inbox_alice', notify: () => {} }));
    const item = renderToStaticMarkup(createElement(FileItem, { asset: value, inboxId: 'inbox_bob', notify: () => {}, onOpenCase: () => {} }));
    expect(row).toContain(label); expect(item).toContain(label);
    expect(row.includes('Download file')).toBe(downloadable);
    expect(item.includes('aria-label="Download brief.txt"')).toBe(downloadable);
    expect(row + item).not.toContain('https://storage.example');
  });
});
