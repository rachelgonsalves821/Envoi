import { useId, useState } from 'react';
import type { AgentWorkMode } from './types';

export const workModeHelp: Record<AgentWorkMode, string> = {
  routine: 'Wakes when a message arrives, handles everyday replies, tells you who contacted it, and asks before important decisions.',
  ask: 'Wakes when a message arrives, tells you who contacted it, and waits for your OK before replying.',
  off: 'Won’t wake for new messages. They wait until you ask. Your own requests still work. You can turn it back on any time. Dots need one short message in ChatGPT.'
};

export const pauseHelp = 'Stops all work, even your requests, until you resume. Messages wait. You can resume without setting up again.';

export function WorkModeHelp({ label, description }: { label: string; description: string }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return <span className="work-mode-help" data-dismissed={dismissed} onPointerLeave={() => setDismissed(false)}>
    <button type="button" className="work-mode-help-trigger" aria-label={`About ${label}`} aria-describedby={id}
      onBlur={() => setDismissed(false)} onClick={() => setDismissed(false)}
      onKeyDown={event => { if (event.key === 'Escape') setDismissed(true); }}>?</button>
    <span className="work-mode-help-tooltip" id={id} role="tooltip">{description}</span>
  </span>;
}
