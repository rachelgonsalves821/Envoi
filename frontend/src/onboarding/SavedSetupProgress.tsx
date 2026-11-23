import { useEffect, useRef, useState } from 'react';
import { saveDotsSetupMode } from '../agent-work-mode';
import type { DotsWorkMode } from '../quick-connect';
import { ConnectionMilestones } from './ConnectionMilestones';
import { savedSetupApi, savedSetupStage, watchSavedSetup, type SavedSetup } from './saved-setup';

const stages = ['waiting', 'approved', 'connected', 'ready'] as const;
const milestones = ['Saved', 'Approved', 'Connected', 'Checked in'];

export function SavedSetupProgress({ setup, onConnected, onStartAgain, organizationId, dotsWorkMode }: {
  setup: SavedSetup;
  onConnected?: () => Promise<unknown>;
  onStartAgain: () => void;
  organizationId?: string;
  dotsWorkMode?: DotsWorkMode;
}) {
  const [status, setStatus] = useState(setup);
  const [unavailable, setUnavailable] = useState<'temporary' | 'ended' | null>(null);
  const [modeSaveError, setModeSaveError] = useState(false);
  const [retryModeSave, setRetryModeSave] = useState(0);
  const savedMode = useRef<{ agentId: string; mode: DotsWorkMode } | null>(null);
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

  const agentId = status.status === 'connected' && status.runtime === 'dots' ? status.agent.id : undefined;
  useEffect(() => {
    if (!agentId || !organizationId || !dotsWorkMode || (savedMode.current?.agentId === agentId && savedMode.current.mode === dotsWorkMode)) return;
    const pending = new AbortController();
    setModeSaveError(false);
    void saveDotsSetupMode(organizationId, setup.workspaceInboxId, agentId, dotsWorkMode, pending.signal).then(() => {
      if (pending.signal.aborted) return;
      savedMode.current = { agentId, mode: dotsWorkMode };
      void refresh.current?.().catch(() => {});
    }).catch(() => { if (!pending.signal.aborted) setModeSaveError(true); });
    return () => pending.abort();
  }, [agentId, organizationId, setup.workspaceInboxId, dotsWorkMode, retryModeSave]);

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
      ready: ['Your Dot checked in', 'Check the Dot’s chat for its setup result.']
    }[stage];
  const canRestart = stage === 'expired' || stage === 'replaced' || unavailable === 'ended';
  return <div className="connection-progress">
    <div role="status" aria-atomic="true">
      <ConnectionMilestones label="Dots setup milestones" milestones={milestones} reached={Math.max(1, reached)} />
      <strong>{message}</strong>
      <p>{hint}</p>
    </div>
    {modeSaveError && <div role="alert"><p>Could not save when the Dot should receive messages.</p><button type="button" className="button secondary compact" onClick={() => setRetryModeSave(value => value + 1)}>Try again</button></div>}
    {canRestart && <button type="button" className="button secondary compact" onClick={onStartAgain}>Start again</button>}
  </div>;
}
