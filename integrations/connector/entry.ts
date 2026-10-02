import { connectorMain } from './cli';
import { ConnectorSetupError } from './adapter';
import { QuickConnectError } from '../openclaw/quick-connect-error';
import { QuickConnectHandoffError } from '../../sdk/typescript/src/quick-connect';

connectorMain().catch(error => {
  const message = error instanceof ConnectorSetupError || error instanceof QuickConnectError || error instanceof QuickConnectHandoffError
    ? error.message : 'Connector failed. Check local configuration and connectivity with doctor; preserve the saved connection for recovery';
  process.stderr.write(`${error instanceof ConnectorSetupError ? `${error.code}: ` : ''}${message}\n`);
  process.exitCode = 1;
});
