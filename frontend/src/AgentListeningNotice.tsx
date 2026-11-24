import { useEffect, useRef, useState } from 'react';
import type { Agent } from './types';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { listeningBanner, listeningConnectorRuntime, listeningFixInstructions } from './agent-listening';
import { onboardingApi } from './onboarding/api';
import { ApiError } from './api';
import { agentWorkMode, isOnDemandAgent, syncMessageFor } from './agent-work-mode';

export function AgentListeningNotice({ agent, inboxId, onReconnect, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: {
  agent: Agent; inboxId: string; onReconnect?: (runtime?: ConnectorRuntime) => void; origin?: string;
}) {
  const mode = agentWorkMode(agent);
  const state = agent.backgroundReceiving?.state;
  const sync = (mode === 'routine' || mode === 'ask') && isOnDemandAgent(agent) &&
    (state === 'off' || state === 'failing' || state === 'starting' || state === 'unavailable');
  const banner = mode === 'off' ? null : listeningBanner(agent);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const [error, setError] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (!banner && !sync) return null;

  async function fix() {
    if ((!banner && !sync) || active.current) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setCopied(false);
    setManualCopy('');
    setError(false);
    try {
      let runtime: ConnectorRuntime | undefined;
      if (!sync && (banner?.action === 'reconnect' || banner?.action === 'restart_connector')) {
        try {
          const result = await onboardingApi.installations(inboxId, agent.id, request.signal);
          if (result.agentId !== agent.id) throw new Error('Installation identity mismatch');
          runtime = listeningConnectorRuntime(result.installations);
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.code === 'FEATURE_DISABLED')) throw cause;
        }
      }
      if (request.signal.aborted) return;
      if (!sync && banner?.action === 'reconnect') { onReconnect?.(runtime); return; }
      const text = sync ? syncMessageFor(agent) : banner && listeningFixInstructions(banner, agent, origin, runtime);
      if (!text) return;
      try { await navigator.clipboard.writeText(text); if (!request.signal.aborted) setCopied(true); }
      catch { if (!request.signal.aborted) setManualCopy(text); }
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      active.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  const showButton = sync || Boolean(banner && banner.action !== 'none' && (banner.action !== 'reconnect' || onReconnect));
  return <section className="inline-notice tone-attention listening-notice" aria-label="Background receiving status">
    <div>
      <strong>{sync ? `Waiting for ${agent.name} to turn it on` : banner?.title}</strong>
      {sync ? <p>Send the sync message in your Dot’s chat.</p> : <p>{banner?.body}</p>}
      <div className="listening-actions">
        {showButton && <button type="button" className="button secondary compact" disabled={busy} onClick={() => void fix()}>
          {sync ? 'Copy sync message' : banner?.action === 'reconnect' ? 'Reconnect' : 'Copy fix instructions'}
        </button>}
        {banner && <a href={banner.docs}>View fix guide</a>}
      </div>
      {copied && <p role="status">{sync ? 'Sync message copied.' : 'Fix instructions copied.'}</p>}
      {error && <p role="alert">Could not look up this agent’s installation. Try again or open the fix guide.</p>}
      {manualCopy && <label className="field">{sync ? 'Sync message' : 'Fix instructions'}<textarea readOnly value={manualCopy} rows={4} onFocus={event => event.currentTarget.select()} /></label>}
    </div>
  </section>;
}
