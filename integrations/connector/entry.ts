import { connectorMain } from './cli';
import { connectorFailureMessage } from './error';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { EnvoiConnector } from '../../sdk/typescript/src/connector';
export type { ConnectorStore, ConnectorSession, ConnectorOptions, CaseSessionWorkHandler, ScopedWakeWorkDriver } from '../../sdk/typescript/src/connector';
export { EnvoiError } from '../../sdk/typescript/src/index';
export { HttpWakeReceiver } from './http-wake-receiver';
export type { WakeStore, WakeState } from './http-wake-receiver';
export { FileWakeStore } from './http-wake-store';
export { createScopedWakeHost } from './http-wake-driver';
export { createWakeHttpHandler } from './http-wake-http';

function directlyExecuted(): boolean {
  if (!process.argv[1]) return false;
  try {
    const executable = realpathSync(process.argv[1]);
    const module = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? executable.toLowerCase() === module.toLowerCase() : executable === module;
  }
  catch { return false; }
}

if (directlyExecuted()) {
  let apiUrl: string | undefined;
  connectorMain(undefined, value => { apiUrl = value; }).catch(error => {
    process.stderr.write(`${connectorFailureMessage(error, apiUrl)}\n`);
    process.exitCode = 1;
  });
}
