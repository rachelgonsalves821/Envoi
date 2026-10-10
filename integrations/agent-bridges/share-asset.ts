import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from './file-store';
import { shareCaseAsset } from './asset-exchange';

async function main() {
  const { ENVOI_API_URL: apiUrl, ENVOI_STATE_DIR: stateDir, ENVOI_CASE_ID: caseId,
    ENVOI_RECIPIENT_AGENT_ID: recipientAgentId, ENVOI_RECIPIENT_ADDRESS: recipientAddress,
    ENVOI_ASSET_PATH: assetPath, ENVOI_ASSET_KEY: idempotencyKey,
    ENVOI_ASSET_TEXT: text, ENVOI_ASSET_MIME_TYPE: mimeType } = process.env;
  if (!apiUrl || !stateDir || !caseId || !recipientAgentId || !recipientAddress || !assetPath || !idempotencyKey || !text || !mimeType) {
    throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR, ENVOI_CASE_ID, ENVOI_RECIPIENT_AGENT_ID, ENVOI_RECIPIENT_ADDRESS, ENVOI_ASSET_PATH, ENVOI_ASSET_KEY, ENVOI_ASSET_TEXT and ENVOI_ASSET_MIME_TYPE are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) throw new Error('An enrolled Envoi connector session is required');
  const bytes = await readFile(assetPath);
  const result = await shareCaseAsset({ connector: new EnvoiConnector(apiUrl, store),
    caseId, recipientAgentId, recipientAddress, filename: path.basename(assetPath),
    mimeType, bytes, idempotencyKey, text });
  process.stdout.write(`Shared clean asset ${result.asset.id} in case ${caseId}.\n`);
}

main().catch(() => {
  process.stderr.write('Envoi clean case asset exchange failed; inspect local configuration, scan status, grant eligibility and credential status.\n');
  process.exitCode = 1;
});
