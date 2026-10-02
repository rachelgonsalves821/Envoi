import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import type { ConnectorAdapter } from './adapter';
import { ConnectorSetupError } from './adapter';
import { openclawAdapter } from '../openclaw/adapter';
import { hermesAdapter } from '../hermes/adapter';
import { grokAdapter } from '../grok/adapter';

// Configuration is opaque to the common lifecycle and validated by its adapter.
export function adapterFor(runtime: ConnectorRuntime): ConnectorAdapter<any> {
  if (runtime === 'openclaw') return openclawAdapter;
  if (runtime === 'hermes') return hermesAdapter;
  if (runtime === 'grok') return grokAdapter;
  throw new ConnectorSetupError('RUNTIME_UNSUPPORTED', 'Choose OpenClaw, Hermes or Grok');
}
