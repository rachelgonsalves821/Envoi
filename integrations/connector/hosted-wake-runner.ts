import { createServer } from 'node:http';
import path from 'node:path';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { FileWakeStore } from './http-wake-store';
import { HttpWakeReceiver } from './http-wake-receiver';
import { createScopedWakeHost } from './http-wake-driver';
import { createWakeHttpHandler } from './http-wake-http';

export interface HostedWakeConfig {
  registeredUrl: string;
  port: number;
  installationId: string;
}

/** The public TLS proxy is operated separately. This process accepts loopback HTTP only. */
export function parseHostedWakeConfig(env: NodeJS.ProcessEnv): HostedWakeConfig | null {
  const supplied = ['ENVOI_WAKE_URL', 'ENVOI_WAKE_PORT', 'ENVOI_WAKE_INSTALLATION_ID'].filter(name => env[name] !== undefined);
  if (!supplied.length) return null;
  if (supplied.length !== 3) throw new Error('Hosted wake needs URL, loopback port and installation ID together');
  const registeredUrl = env.ENVOI_WAKE_URL!;
  const url = new URL(registeredUrl);
  if (url.protocol !== 'https:' || url.href !== registeredUrl || url.username || url.password || url.port || url.search || url.hash
    || url.pathname === '/' || registeredUrl.length > 2048) throw new Error('Hosted wake needs a fixed canonical public HTTPS URL');
  const portText = env.ENVOI_WAKE_PORT!;
  if (!/^[0-9]{4,5}$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) throw new Error('Hosted wake needs an unprivileged loopback port');
  const installationId = env.ENVOI_WAKE_INSTALLATION_ID!;
  if (!/^installation_[A-Za-z0-9_-]{3,128}$/.test(installationId)) throw new Error('Hosted wake needs the approved installation ID');
  return { registeredUrl, port: Number(portText), installationId };
}

export async function runHostedWake(options: {
  connector: EnvoiConnector;
  session: ConnectorSession;
  stateDir: string;
  config: HostedWakeConfig;
  signal: AbortSignal;
  onListening?: () => void | Promise<void>;
}): Promise<void> {
  const { connector, session, stateDir, config, signal } = options;
  if (!path.isAbsolute(stateDir) || !/^agent_[A-Za-z0-9_-]{3,128}$/.test(session.agentId)
    || !/^inbox_[A-Za-z0-9_-]{3,128}$/.test(session.inboxId)) throw new Error('Hosted wake needs an enrolled private scoped connector');
  const store = await FileWakeStore.open(path.join(stateDir, 'wake'));
  try {
    const host = createScopedWakeHost({ connector, store, origin: connector.wakeOrigin,
      identity: { agentId: session.agentId, inboxId: session.inboxId, installationId: config.installationId },
      registeredUrl: config.registeredUrl });
    const receiver = new HttpWakeReceiver({ origin: connector.wakeOrigin, registeredUrl: config.registeredUrl, store });
    const url = new URL(config.registeredUrl);
    const server = createServer(createWakeHttpHandler({ path: url.pathname, receiver, host, signal,
      onError: () => process.stderr.write('Hosted wake dispatch failed; canonical polling remains active.\n') }));
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(config.port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
      });
      process.stdout.write(`Hosted wake receiver listening on 127.0.0.1:${config.port}${url.pathname}; public TLS is operator-managed.\n`);
      await options.onListening?.();
      await host.run(signal);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally { await store.close(); }
}
