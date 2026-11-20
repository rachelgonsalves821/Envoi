import { useState } from 'react';
import { syncMessageFor } from './agent-work-mode';
import type { Agent } from './types';

export const dotReceivingSyncTitle = 'One more step to turn it on';

export function DotReceivingSync({ agent, showChatGPTLink = false }: {
  agent: Pick<Agent, 'name' | 'address'>;
  showChatGPTLink?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const message = syncMessageFor(agent);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return <>
    <p>ChatGPT needs {agent.name} to switch this on itself. Open your {agent.name} chat in ChatGPT and send this message:</p>
    <code className="dot-sync-message">{message}</code>
    <div className="listening-actions">
      <button type="button" className="button secondary compact" onClick={() => void copy()}>Copy message</button>
      {showChatGPTLink && <a className="button primary compact" href="https://chatgpt.com/" target="_blank" rel="noreferrer">Open ChatGPT</a>}
    </div>
    {copyStatus === 'copied' && <p role="status">Message copied.</p>}
    {copyStatus === 'failed' && <p role="alert">Could not copy. Select the message above and copy it manually.</p>}
  </>;
}
