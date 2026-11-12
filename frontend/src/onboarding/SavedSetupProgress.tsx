import { useEffect, useRef, useState } from 'react';
import { ConnectionMilestones } from './ConnectionMilestones';
import { savedSetupApi, savedSetupStage, watchSavedSetup, type SavedSetup } from './saved-setup';

const stages = ['waiting', 'approved', 'connected', 'ready'] as const;
const milestones = ['Saved', 'Approved', 'Connected', 'Ready'];

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
  const reached = stages.findIndex(name => stage === name) + 1;
  const [message, hint] = unavailable === 'ended' ? ['This setup is no longer available', 'Start again to get a new setup prompt.']
    : unavailable === 'temporary' ? ["Can't check progress right now", 'Your Dot can keep going.']
    : stage === 'expired' ? ['This setup expired', status.status === 'expired' && status.reason === 'approval_lapsed' ? 'The approval expired or was withdrawn.' : 'Start again to approve a new setup.']
    : stage === 'replaced' ? ['A newer Dots setup replaced this one', 'Continue with the newer setup or start again.']
    : {
      waiting: ['Waiting for approval', 'Paste the setup prompt into your Dot’s chat to begin.'],
      approved: ['Access approved', 'Return to the Dot’s chat to finish connecting.'],
      connected: ['Your Dot is connected', 'The Dot still needs to verify its connection.'],
      ready: ['Your Dot is ready', 'It can use Envoi from its chat.']
    }[stage];
  const canRestart = stage === 'expired' || stage === 'replaced' || unavailable === 'ended';
  return <div className="connection-progress">
    <div role="status" aria-atomic="true">
      <ConnectionMilestones label="Dots setup milestones" milestones={milestones} reached={Math.max(1, reached)} />
      <strong>{message}</strong>
      <p>{hint}</p>
    </div>
    {canRestart && <button type="button" className="button secondary compact" onClick={onStartAgain}>Start again</button>}
  </div>;
}
