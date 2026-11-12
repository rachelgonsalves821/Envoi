import { useState } from 'react';
import { dotsDiagnosticPrompt, dotsMessageAccessPrompt, dotsMonitoringPrompt, dotsSetupPrompt, dotsVerificationPrompt, setupHelpLabel } from '../quick-connect';
import type { Agent } from '../types';
import { canReconnectAgent } from './types';

export function DotsSetupGuide({ origin, name, address = '', reconnect = false }: {
  origin: string; name?: string; address?: string; reconnect?: boolean;
}) {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const connectionPrompt = dotsSetupPrompt(origin, name ?? 'my Dot', address || 'the address I approve', reconnect);
  const accessPrompt = dotsMessageAccessPrompt(address);
  const primaryPrompt = reconnect ? accessPrompt : connectionPrompt;
  const primaryLabel = reconnect ? 'Message access prompt' : 'Setup prompt';
  const alternatives = [
    { title: 'Check connection', label: 'Verification prompt', prompt: dotsVerificationPrompt(address) },
    reconnect
      ? { title: 'Reconnect an existing agent', label: 'Connection prompt', prompt: connectionPrompt }
      : { title: 'Add send access', label: 'Message access prompt', prompt: accessPrompt },
    { title: 'Background receiving', label: 'Monitoring prompt', prompt: dotsMonitoringPrompt },
    { title: 'Collect a report', label: 'Diagnostic prompt', prompt: dotsDiagnosticPrompt(address) }
  ];

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setError('');
    } catch {
      setCopied('');
      setError(`Clipboard access is unavailable. Open “${setupHelpLabel}” and select the text to copy it.`);
    }
  }

  return <section className="dots-guide" aria-label={reconnect ? 'Reconnect Dots permissions' : 'Dots connection instructions'}>
    <p>{reconnect ? 'Paste this into your existing Dot chat to review or update its message access.' : "Paste this into your Dot's chat. It will guide you through the Envoi plugin and approval."}</p>
    <div className="setup-handoff-actions">
      <button className="button primary" type="button" onClick={() => void copy(primaryPrompt, primaryLabel)}>
        {reconnect ? 'Copy message access prompt' : 'Copy setup prompt'}
      </button>
    </div>
    {!reconnect && <p>After you approve on Envoi's page, {name || 'your Dot'} appears in your agents.</p>}
    {copied && <p role="status">{copied} copied.</p>}
    {error && <p role="alert">{error}</p>}
    <details className="setup-details setup-help">
      <summary>{setupHelpLabel}</summary>
      <label className="field">
        <span>{primaryLabel}</span>
        <textarea readOnly value={primaryPrompt} rows={5} onFocus={event => event.currentTarget.select()} />
      </label>
      {reconnect && <p>Envoi replaces this agent’s active installations after approval and ends their monitoring subscriptions. Review the installations before confirming.</p>}
      {alternatives.map(({ title, label, prompt }) => <section key={label} className="setup-help-option">
        <label className="field">
          <strong>{title}</strong>
          <textarea aria-label={label} readOnly value={prompt} rows={5} onFocus={event => event.currentTarget.select()} />
        </label>
        <button className="button secondary" type="button" onClick={() => void copy(prompt, label)}>Copy {label.toLowerCase()}</button>
      </section>)}
      <label className="field">
        <span>MCP server URL</span>
        <input readOnly value={`${origin}/mcp`} onFocus={event => event.currentTarget.select()} />
        <small>For connection diagnostics.</small>
      </label>
      <button className="button secondary" type="button" onClick={() => void copy(`${origin}/mcp`, 'Server URL')}>Copy server URL</button>
    </details>
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
    {agent && <><p>Recorded message access: {agent.permissions.includes('send_agent_messages') ? 'send and receive' : 'receive only'}. Verify the active plugin before changing anything. Reconnect only if the required permission is missing; then verify again after approval.</p><DotsSetupGuide key={agent.id} origin={origin} name={agent.name} address={agent.address} reconnect /></>}
  </details>;
}
