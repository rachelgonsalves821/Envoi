import { ConnectorSetupError } from './adapter';
import { QuickConnectError } from '../openclaw/quick-connect-error';
import { QuickConnectHandoffError } from '../../sdk/typescript/src/quick-connect';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { guidanceText, lifecyclePolicy } from '../../sdk/typescript/src/lifecycle';
import { ConnectorContractError, ConnectorPersistenceError } from '../../sdk/typescript/src/connector';

export function connectorErrorMessage(error: unknown): string {
  if (error instanceof ConnectorSetupError) return `${error.code}: ${error.message}`;
  if (error instanceof ConnectorContractError) return 'WORK_CONTRACT_ERROR: The connector could not use the Envoi work API. Run status for the saved failure before restarting.';
  if (error instanceof ConnectorPersistenceError) return 'STATE_PERSISTENCE_FAILED: The connector could not save private state. Run status and preserve the saved connection for recovery.';
  if (error instanceof QuickConnectError || error instanceof QuickConnectHandoffError) return error.message;
  if (error instanceof EnvoiError) {
    const policy = lifecyclePolicy(error);
    if (policy.guidance !== 'none') return `${error.code ?? 'SERVICE_UNAVAILABLE'}: ${guidanceText(policy.guidance)}`;
  }
  return 'Connector failed. Run status on the existing connection to inspect its saved diagnostics.';
}
