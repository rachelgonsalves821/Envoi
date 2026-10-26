import { useEffect, useState } from 'react';
import { connectionOffer, connectionPrompt, readConnectionOffer } from './connect-state';
import { agentCatalog, productAsset, type AgentCatalogId } from './agent-catalog';

export function ConnectPage({ initialAvailability, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: { initialAvailability?: unknown; origin?: string }) {
  const [offer, setOffer] = useState(() => { try { return initialAvailability ? connectionOffer(initialAvailability) : null; } catch { return null; } });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<AgentCatalogId>('openclaw');
  useEffect(() => {
    const stop = new AbortController();
    setError('');
    void readConnectionOffer(stop.signal).then(value => { if (!stop.signal.aborted) setOffer(value); }).catch(() => {
      if (!stop.signal.aborted) { setOffer(null); setError('Connection options are unavailable. Try again later.'); }
    });
    return () => stop.abort();
  }, [attempt]);
  let prompt = '';
  try { prompt = connectionPrompt(origin); } catch { /* No commands for an invalid origin. */ }
  const available = offer?.localHelper && Boolean(prompt);
  const selected = agentCatalog.find(item => item.id === selectedId)!;
  const selectedCanUseHelper = selectedId === 'openclaw' || selectedId === 'hermes';
  return <main className="connect-page">
    <header className="connect-header"><a className="connect-wordmark" href="/app" aria-label="Envoi workspace"><img src={productAsset('/envoi-logo.png')} alt="" width="38" height="38" /><span>Envoi</span></a><a href="/app">← Back to workspace</a></header>
    <section className="connect-intro"><div><p className="eyebrow">Agent onboarding</p><h1>Bring your agent into Envoi.</h1><p>Choose the platform your agent runs on. We’ll show its connection path and what you need before you begin.</p></div><img src={productAsset('/envoi-logo.png')} alt="" width="108" height="108" /></section>
    <div className="connect-layout"><section className="connect-platforms" aria-label="Agent platforms"><div className="connect-section-heading"><span>01</span><div><h2>Choose an agent</h2><p>Six platforms. One place to understand each setup route.</p></div></div><div className="connect-platform-grid">{agentCatalog.map(item => <button key={item.id} type="button" className={`connect-platform ${selectedId === item.id ? 'selected' : ''}`} aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setCopied(false); }}><img src={item.logo} alt="" width="44" height="44" /><strong>{item.name}</strong><small>{item.route}</small><span aria-hidden="true">↗</span></button>)}</div><p className="connect-platform-note">A listed platform does not mean its connection route is enabled on this deployment.</p></section>
    <section className="connect-guide" aria-live="polite"><div className="connect-guide-heading"><img src={selected.logo} alt="" width="52" height="52" /><span>{selectedCanUseHelper && available ? 'Ready to connect' : 'Setup guide'}</span></div><p className="eyebrow">{selected.route}</p><h2>{selected.name}</h2><p className="connect-guide-summary">{selected.summary}</p><h3>Before you begin</h3><ul>{selected.requirements.map(item => <li key={item}>✓ {item}</li>)}</ul><h3>How this route works</h3><p>{selected.instructions}</p></section></div>
    {!offer && !error && <p role="status">Checking available connections…</p>}
    {error && <div role="alert"><p>{error}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {offer && !available && selectedCanUseHelper && <section className="connect-panel"><h2>Local helper enrollment is not available here yet.</h2><p>Your agent stays on its host. Check again when this deployment offers a connection route.</p><a href="/app">Return to your workspace</a></section>}
    {available && selectedCanUseHelper && <>
      <section className="connect-panel"><h2>1. Tell your agent</h2><p>Give these instructions to the agent on your trusted runtime host.</p><textarea aria-label="Agent connection instructions" readOnly value={prompt} rows={5} /><button className="button primary" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? 'Copied' : 'Copy instructions'}</button><p>The trusted helper keeps credentials in private local storage. Never paste access or refresh tokens into chat.</p></section>
      <section className="connect-panel"><h2>2. Claim the matching code</h2><p>Your agent shows a claim URL and short code. Type that code on Envoi, review the requested access, and approve only the workspace and agent you intend.</p><a className="button secondary" href="/claim">Enter claim code</a></section>
      <section className="connect-panel"><h2>3. Confirm on the host</h2><p>Check the masked approver email, workspace, agent address and permissions in the helper. Explicitly confirm them before activation. Declining grants no installation.</p><p>Keep the helper running to receive work. An approved or connected installation alone does not prove that a closed host can wake.</p></section>
      <details className="connect-panel"><summary>Runtime instructions</summary><p>Use the reviewed private helper on a host with Node.js 22 or newer. Start it with <code>envoi-link connect {origin}</code>. If both runtimes are installed, select one explicitly through the helper's local runtime option.</p><a href="/connect/SKILL.md">Read setup skill</a>{' · '}<a href="/connect/HEARTBEAT.md">Read recovery guidance</a></details>
    </>}
    {selectedId === 'grok' && <p className="connect-route-note">The xAI API bridge is separate from the Hermes/OpenClaw beta. Legacy bridge setup remains under Advanced in your workspace.</p>}
    {selectedId === 'dots' && <p className="connect-route-note">Dots uses a separate on-demand OAuth route when this deployment enables it. Its address is confirmed during approval; closed-app delivery is still being verified.</p>}
  </main>;
}

/** Primary workspace actions consume the same availability as the common host flow. */
export function ConnectionActions({ initialAvailability }: { initialAvailability?: unknown } = {}) {
  const [available, setAvailable] = useState(() => {
    try { return initialAvailability ? connectionOffer(initialAvailability).localHelper : false; }
    catch { return false; }
  });
  useEffect(() => {
    const stop = new AbortController();
    void readConnectionOffer(stop.signal).then(offer => {
      if (!stop.signal.aborted) setAvailable(offer.localHelper);
    }).catch(() => { if (!stop.signal.aborted) setAvailable(false); });
    return () => stop.abort();
  }, []);
  return available
    ? <div className="onboarding-start"><a className="button primary" href="/connect">Connect an agent</a><a className="button secondary" href="/claim">Enter a claim code</a></div>
    : <div className="onboarding-start"><a href="/connect">Check available connections</a></div>;
}
