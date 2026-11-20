import { useId, useState } from 'react';
import type { AgentWorkMode } from './types';

export const workModeHelp: Record<AgentWorkMode, string> = {
  routine: 'Wakes when a message arrives, handles everyday replies, tells you who contacted it, and asks you before important decisions.',
  ask: 'Wakes when a message arrives, tells you, and waits for your OK before replying.',
  off: "Won't wake for new messages. They wait until you ask. Your own requests still work. Turn it back on any time (a Dot needs one short message)."
};

export const pauseHelp = 'Stops everything, even your own requests, until you resume it. Messages wait. No new setup is needed.';

export function WorkModeHelp({ label, description }: { label: string; description: string }) {
  const id = useId();
  const [visibility, setVisibility] = useState<'auto' | 'open' | 'dismissed'>('auto');
  return <span className="work-mode-help" data-visibility={visibility}
    onPointerLeave={() => { if (visibility === 'dismissed') setVisibility('auto'); }}>
    <button type="button" className="work-mode-help-trigger" aria-label={`About ${label}`} aria-describedby={id}
      onBlur={() => setVisibility('auto')} onClick={() => setVisibility(visibility === 'open' ? 'dismissed' : 'open')}
      onKeyDown={event => { if (event.key === 'Escape') setVisibility('dismissed'); }}>?</button>
    <span className="work-mode-help-tooltip" id={id} role="tooltip">{description}</span>
  </span>;
}
