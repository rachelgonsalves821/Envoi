import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { EnvoiWakeHostTransport, HttpWakeHost, type WakeIdentity } from './http-wake-host';
import type { WakeStore } from './http-wake-receiver';

export interface ScopedWakeHostOptions {
  connector: EnvoiConnector;
  store: WakeStore;
  origin: string;
  identity: WakeIdentity;
  registeredUrl: string;
}

export function createScopedWakeHost(options: ScopedWakeHostOptions): HttpWakeHost {
  if (!(options.connector instanceof EnvoiConnector)) throw new TypeError('An EnvoiConnector instance is required');
  const driver = options.connector.scopedWakeWorkDriver();
  const transport = new EnvoiWakeHostTransport(options.origin, options.identity, options.connector);
  return new HttpWakeHost(transport, options.store, driver, options.registeredUrl);
}
