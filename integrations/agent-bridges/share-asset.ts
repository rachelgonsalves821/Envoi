import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SinaloaConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from './file-store';
import { shareCaseAsset } from './asset-exchange';

async function main() {
  const { SINALOA_API_URL: apiUrl, SINALOA_STATE_DIR: stateDir, SINALOA_CASE_ID: caseId,
    SINALOA_RECIPIENT_AGENT_ID: recipientAgentId, SINALOA_RECIPIENT_ADDRESS: recipientAddress,
    SINALOA_ASSET_PATH: assetPath, SINALOA_ASSET_KEY: idempotencyKey,
    SINALOA_ASSET_TEXT: text, SINALOA_ASSET_MIME_TYPE: mimeType } = process.env;
  if (!apiUrl || !stateDir || !caseId || !recipientAgentId || !recipientAddress || !assetPath || !idempotencyKey || !text || !mimeType) {
    throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR, SINALOA_CASE_ID, SINALOA_RECIPIENT_AGENT_ID, SINALOA_RECIPIENT_ADDRESS, SINALOA_ASSET_PATH, SINALOA_ASSET_KEY, SINALOA_ASSET_TEXT and SINALOA_ASSET_MIME_TYPE are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) throw new Error('An enrolled Sinaloa connector session is required');
  const bytes = await readFile(assetPath);
  const result = await shareCaseAsset({ connector: new SinaloaConnector(apiUrl, store),
    caseId, recipientAgentId, recipientAddress, filename: path.basename(assetPath),
    mimeType, bytes, idempotencyKey, text });
  process.stdout.write(`Shared clean asset ${result.asset.id} in case ${caseId}.\n`);
}

main().catch(() => {
  process.stderr.write('Sinaloa clean case asset exchange failed; inspect local configuration, scan status, grant eligibility and credential status.\n');
  process.exitCode = 1;
});
