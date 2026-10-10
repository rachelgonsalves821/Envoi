import { ConnectorSetupError } from './adapter';
import { QuickConnectError } from '../openclaw/quick-connect-error';
import { QuickConnectHandoffError } from '../../sdk/typescript/src/quick-connect';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { guidanceText, lifecyclePolicy } from '../../sdk/typescript/src/lifecycle';

export function connectorErrorMessage(error: unknown): string {
  if (error instanceof ConnectorSetupError) return `${error.code}: ${error.message}`;
  if (error instanceof QuickConnectError || error instanceof QuickConnectHandoffError) return error.message;
  if (error instanceof EnvoiError) {
    const policy = lifecyclePolicy(error);
    if (policy.guidance !== 'none') return `${error.code ?? 'SERVICE_UNAVAILABLE'}: ${guidanceText(policy.guidance)}`;
  }
  return 'Connector failed. Check local configuration and connectivity with doctor; preserve the saved connection for recovery';
}
