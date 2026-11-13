import { useState } from 'react';
import { dotsMessageAccessPrompt, dotsSetupPrompt } from '../quick-connect';
import type { Agent } from '../types';
import { canReconnectAgent } from './types';

export function DotsSetupGuide({ origin, name, address = '', reconnect = false, savedSetup = false, messageAccess = false }: {
  origin: string; name?: string; address?: string; reconnect?: boolean; savedSetup?: boolean; messageAccess?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const prompt = messageAccess ? dotsMessageAccessPrompt(address)
    : dotsSetupPrompt(origin, name ?? 'my Dot', address || 'the address I approve', reconnect, savedSetup);
  const promptLabel = messageAccess ? 'Message access prompt' : 'Setup prompt';

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return <section className="dots-guide" aria-label={messageAccess ? 'Reconnect Dots permissions' : 'Dots connection instructions'}>
    <p>{messageAccess ? 'Paste this into your existing Dot chat to review or update its message access.' : "Paste this into your Dot's chat. It will guide you through the Envoi plugin and approval."}</p>
    <div className="setup-handoff-actions">
      <button className="button primary" type="button" onClick={() => void copy()}>
        {messageAccess ? 'Copy message access prompt' : 'Copy setup prompt'}
      </button>
    </div>
    {copied && <p role="status">{promptLabel} copied.</p>}
    {copyFailed && <>
      <p role="alert">Could not copy. Select the prompt below to copy it manually.</p>
      <label className="field">
        <span>{promptLabel}</span>
        <textarea readOnly value={prompt} rows={5} onFocus={event => event.currentTarget.select()} />
      </label>
    </>}
    {(reconnect || messageAccess) && <p>Approval replaces this agent’s active installations and ends their monitoring subscriptions. Review the installations before confirming.</p>}
    <a className="dots-setup-help" href="/docs/dots/" target="_blank" rel="noreferrer">Stuck? Dots setup guide</a>
  </section>;
}

/** Uses the approved OAuth existing-agent route, without attempting an editor-based scope expansion. */
export function DotsPermissionRecovery({ agents, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: { agents: Agent[]; origin?: string }) {
  const [agentId, setAgentId] = useState('');
  const eligible = agents.filter(canReconnectAgent);
  const agent = eligible.find(item => item.id === agentId);
  if (!eligible.length) return null;
  return <details className="onboarding-advanced dots-permission-recovery">
    <summary>Change Dots permissions</summary><p>Choose the existing identity and verify its active plugin connection first. Request a new OAuth approval only if message access is missing.</p>
    <label className="field"><span>Dot’s Envoi agent</span><select value={agent?.id || ''} onChange={event => setAgentId(event.target.value)}><option value="">Choose an agent</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name} · {item.address}</option>)}</select></label>
    {agent && <><p>Recorded message access: {agent.permissions.includes('send_agent_messages') ? 'send and receive' : 'receive only'}. Verify the active plugin before changing anything. Reconnect only if the required permission is missing; then verify again after approval.</p><DotsSetupGuide key={agent.id} origin={origin} name={agent.name} address={agent.address} messageAccess /></>}
  </details>;
}
