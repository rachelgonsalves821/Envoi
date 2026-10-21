import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import contract from '../../test/contract-fixtures/agent-registration/schemas.json';
import { EnvoiConnector, type ConnectorSession, type WorkHandler } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { acquireConnectorLock, privateDirectory } from '../connector/store';
import { createHelper } from './envoi-link.mjs';

export interface PortableRestHostOptions {
  /** Selected by trusted host configuration, never copied from model-visible skill text. */
  origin: string;
  directory: string;
  runtime: { type: string; version: string };
  helper: { name: string; version: string };
  deliveryCapabilities: { persistentProcess: true; outboundHttps: true; sse: true; webhook: false; scheduledPolling: false; a2a: false };
  /** An attributable host-native prompt. A model answer is not confirmation. */
  confirm: (details: Record<string, unknown>) => Promise<boolean | null>;
  /** Durable admission and idempotent processing supplied by the actual host. */
  handler: WorkHandler;
  fetch?: typeof fetch;
}

function validRuntimeSession(session: ConnectorSession | null, options: PortableRestHostOptions, origin: string) {
  const marker = (session as ConnectorSession & { _onboarding?: {
    origin?: string; completionId?: string; runtime?: { type?: string; version?: string };
    agent?: { id?: string; address?: string };
    installation?: { id?: string; agentId?: string; connectionRoute?: string; deliveryMode?: string;
      runtime?: { type?: string; version?: string } };
  } } | null)?._onboarding;
  return !!session && !!marker && marker.origin === origin
    && marker.runtime?.type === options.runtime.type && marker.runtime.version === options.runtime.version
    && marker.installation?.connectionRoute === 'authenticated_rest' && marker.installation.deliveryMode === 'envoi_link'
    && marker.installation.runtime?.type === options.runtime.type && marker.installation.runtime.version === options.runtime.version
    && marker.agent?.id === session.agentId && marker.agent.address === session.address
    && marker.installation.agentId === session.agentId
    && typeof marker.completionId === 'string' && !!marker.completionId
    && typeof marker.installation.id === 'string' && !!marker.installation.id
    && typeof session.agentApiToken === 'string' && session.agentApiToken.startsWith('envoi_agent_access_')
    && typeof session.agentRefreshToken === 'string' && session.agentRefreshToken.startsWith('envoi_agent_refresh_');
}

async function completed(directory: string, origin: string, options: PortableRestHostOptions) {
  const filename = path.join(directory, 'helper-state.json');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new Error('PORTABLE_REST_STATE_INVALID');
  const state = JSON.parse(await readFile(filename, 'utf8')) as Record<string, any>;
  if (state.version !== 1 || state.origin !== origin || state.phase !== 'completed'
    || state.connectionRoute !== 'authenticated_rest' || state.runtime?.type !== options.runtime.type
    || state.runtime.version !== options.runtime.version || typeof state.completionId !== 'string' || !state.completionId) {
    throw new Error('PORTABLE_REST_SETUP_INCOMPLETE');
  }
  return state.completionId;
}

/** Trusted-process bridge from approved REST activation to the existing fenced connector. */
export async function createPortableRestHost(options: PortableRestHostOptions) {
  if (!options || typeof options.confirm !== 'function' || !options.handler
    || typeof options.handler.admit !== 'function' || typeof options.handler.process !== 'function'
    || !path.isAbsolute(options.directory)) throw new Error('PORTABLE_REST_HOST_REQUIRED');
  const directory = await privateDirectory(options.directory);
  const store = new FileBridgeStore(directory);
  await store.init();
  const helper = await createHelper({ ...options, contract, directory, connectionRoute: 'authenticated_rest',
    adopt: async (activation: { installation?: { id?: string } }, context: { origin: string; completionId: string }) => {
      const session = await store.load();
      if (!validRuntimeSession(session, options, context.origin)
        || (session as any)._onboarding.completionId !== context.completionId
        || (session as any)._onboarding.installation.id !== activation.installation?.id) throw new Error('PORTABLE_REST_ADOPTION_INVALID');
    } });
  const origin = new URL(options.origin).origin;
  const connector = new EnvoiConnector(origin, store, { handler: options.handler, fetch: options.fetch });
  return {
    connect: () => helper.connect(),
    resume: () => helper.resume(),
    status: () => helper.status(),
    /** Run only from a supervised host process after confirmation and authenticated setup. */
    async run(signal: AbortSignal) {
      const release = await acquireConnectorLock(directory);
      try {
        const completionId = await completed(directory, origin, options);
        const session = await store.load();
        if (!validRuntimeSession(session, options, origin)
          || (session as any)._onboarding.completionId !== completionId) throw new Error('PORTABLE_REST_STATE_INVALID');
        await connector.run(signal);
      } finally { await release(); }
    },
    /** Use only inside trusted host code; never expose this object to the model. */
    connector,
  };
}
