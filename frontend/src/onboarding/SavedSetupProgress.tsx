import { useEffect, useRef, useState } from 'react';
import { savedSetupApi, savedSetupStage, watchSavedSetup, type SavedSetup } from './saved-setup';

const stages = [
  ['waiting', 'Waiting for approval'],
  ['approved', 'Approved'],
  ['connected', 'Connected'],
  ['ready', 'Ready']
] as const;

export function SavedSetupProgress({ setup, onConnected, onStartAgain }: {
  setup: SavedSetup;
  onConnected?: () => Promise<unknown>;
  onStartAgain: () => void;
}) {
  const [status, setStatus] = useState(setup);
  const [unavailable, setUnavailable] = useState<'temporary' | 'ended' | null>(null);
  const refresh = useRef(onConnected);
  refresh.current = onConnected;
  useEffect(() => {
    let connected = false;
    return watchSavedSetup({
      request: signal => savedSetupApi.status(setup.workspaceInboxId, setup.setupId, signal),
      onStatus(next) {
        setStatus(next);
        setUnavailable(null);
        if (!connected && next.status === 'connected') {
          connected = true;
          void refresh.current?.().catch(() => {});
        }
      },
      onUnavailable: terminal => setUnavailable(terminal ? 'ended' : 'temporary')
    });
  }, [setup.workspaceInboxId, setup.setupId]);

  const stage = savedSetupStage(status);
  const current = stages.findIndex(([name]) => stage === name);
  const message = unavailable === 'ended' ? 'This setup is no longer available.'
    : unavailable === 'temporary' ? "Can't check progress right now. Your Dot can keep going."
    : status.status === 'expired' ? status.reason === 'approval_lapsed' ? 'This approval expired or was withdrawn.' : 'This setup expired before approval.'
    : status.status === 'replaced' ? 'A newer Dots setup replaced this one.'
    : stages[current][1];
  const canRestart = stage === 'expired' || stage === 'replaced' || unavailable === 'ended';
  return <div className="connection-progress">
    <div role="status" aria-atomic="true">
      <ol className="connection-progress-dots" aria-label="Dots setup milestones">
        {stages.map(([key, label], index) => <li key={key} className={index <= current ? 'complete' : undefined}
          aria-current={index === current ? 'step' : undefined}>{label}</li>)}
      </ol>
      <strong>{message}</strong>
      {'agent' in status && <p>{status.agent.address}</p>}
    </div>
    {canRestart && <button type="button" className="button secondary compact" onClick={onStartAgain}>Start again</button>}
  </div>;
}
