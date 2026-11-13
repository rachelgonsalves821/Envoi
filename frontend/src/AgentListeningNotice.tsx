import { useEffect, useRef, useState } from 'react';
import type { Agent } from './types';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { listeningBanner, listeningConnectorRuntime, listeningFixInstructions } from './agent-listening';
import { onboardingApi } from './onboarding/api';
import { ApiError } from './api';

export function AgentListeningNotice({ agent, inboxId, onReconnect, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: {
  agent: Agent; inboxId: string; onReconnect?: (runtime?: ConnectorRuntime) => void; origin?: string;
}) {
  const banner = listeningBanner(agent);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const [error, setError] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (!banner) return null;

  async function fix() {
    if (!banner || active.current) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setCopied(false);
    setManualCopy('');
    setError(false);
    try {
      let runtime: ConnectorRuntime | undefined;
      if (banner.action === 'reconnect' || banner.action === 'restart_connector') {
        try {
          const result = await onboardingApi.installations(inboxId, agent.id, request.signal);
          if (result.agentId !== agent.id) throw new Error('Installation identity mismatch');
          runtime = listeningConnectorRuntime(result.installations);
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.code === 'FEATURE_DISABLED')) throw cause;
        }
      }
      if (request.signal.aborted) return;
      if (banner.action === 'reconnect') { onReconnect?.(runtime); return; }
      const text = listeningFixInstructions(banner, agent, origin, runtime);
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

  const showButton = banner.action !== 'none' && (banner.action !== 'reconnect' || Boolean(onReconnect));
  return <section className="inline-notice tone-attention listening-notice" aria-label="Background receiving status">
    <div>
      <strong>{banner.title}</strong>
      <p>{banner.body}</p>
      <div className="listening-actions">
        {showButton && <button type="button" className="button secondary compact" disabled={busy} onClick={() => void fix()}>
          {banner.action === 'reconnect' ? 'Reconnect' : 'Copy fix instructions'}
        </button>}
        <a href={banner.docs}>View fix guide</a>
      </div>
      {copied && <p role="status">Fix instructions copied.</p>}
      {error && <p role="alert">Could not look up this agent’s installation. Try again or open the fix guide.</p>}
      {manualCopy && <label className="field">Fix instructions<textarea readOnly value={manualCopy} rows={4} onFocus={event => event.currentTarget.select()} /></label>}
    </div>
  </section>;
}
