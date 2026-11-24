import { ConnectorSetupError } from './adapter';
import { QuickConnectError } from '../openclaw/quick-connect-error';
import { QuickConnectHandoffError, quickConnectOrigin } from '../../sdk/typescript/src/quick-connect';
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

export function connectorFailureMessage(error: unknown, apiUrl?: string): string {
  let origin = 'https://www.envoi-agents.com';
  if (apiUrl) {
    try { origin = quickConnectOrigin(apiUrl); }
    catch { /* An invalid URL may include private input. Use the public docs. */ }
  }
  let code = 'SETUP_FAILED';
  if (error instanceof ConnectorSetupError && /^[A-Z][A-Z0-9_]*$/.test(error.code)) code = error.code;
  else if (error instanceof QuickConnectHandoffError) code = 'HANDOFF_INVALID';
  else if (error instanceof EnvoiError && error.code && ['INSUFFICIENT_SCOPE', 'OAUTH_RECONSENT_REQUIRED', 'FEATURE_DISABLED'].includes(error.code)) code = error.code;
  return `${connectorErrorMessage(error)}\nFix: ${origin}/docs/fix/#${code}`;
}
