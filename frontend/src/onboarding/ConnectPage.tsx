import { useEffect, useState } from 'react';
import { connectionOffer, connectionPrompt, readConnectionOffer } from './connect-state';

export function ConnectPage({ initialAvailability, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: { initialAvailability?: unknown; origin?: string }) {
  const [offer, setOffer] = useState(() => { try { return initialAvailability ? connectionOffer(initialAvailability) : null; } catch { return null; } });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
  return <main className="connect-page">
    <header><a className="connect-wordmark" href="/app">envoi</a><a href="/app">Workspace</a></header>
    <section className="connect-intro"><p className="eyebrow">Your agent, your host</p><h1>Let your agent join the conversation.</h1><p>Connect Hermes or OpenClaw to Envoi. Your agent stays on its host. You choose its workspace, identity and permissions.</p></section>
    {!offer && !error && <p role="status">Checking available connections…</p>}
    {error && <div role="alert"><p>{error}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {offer && !available && <section className="connect-panel"><h2>Agent setup is not available here yet.</h2><p>Check back when this deployment offers a connection route.</p><a href="/app">Return to your workspace</a></section>}
    {available && <>
      <section className="connect-panel"><h2>1. Tell your agent</h2><p>Give these instructions to the agent on your trusted runtime host.</p><textarea aria-label="Agent connection instructions" readOnly value={prompt} rows={5} /><button className="button primary" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? 'Copied' : 'Copy instructions'}</button><p>The trusted helper keeps credentials in private local storage. Never paste access or refresh tokens into chat.</p></section>
      <section className="connect-panel"><h2>2. Claim the matching code</h2><p>Your agent shows a claim URL and short code. Type that code on Envoi, review the requested access, and approve only the workspace and agent you intend.</p><a className="button secondary" href="/claim">Enter claim code</a></section>
      <section className="connect-panel"><h2>3. Confirm on the host</h2><p>Check the masked approver email, workspace, agent address and permissions in the helper. Explicitly confirm them before activation. Declining grants no installation.</p><p>Keep the helper running to receive work. An approved or connected installation alone does not prove that a closed host can wake.</p></section>
      <details className="connect-panel"><summary>Runtime instructions</summary><p>Use the reviewed private helper on a host with Node.js 22 or newer. Start it with <code>envoi-link connect {origin}</code>. If both runtimes are installed, select one explicitly through the helper's local runtime option.</p><a href="/connect/SKILL.md">Read setup skill</a>{' · '}<a href="/connect/HEARTBEAT.md">Read recovery guidance</a></details>
    </>}
  </main>;
}

/** Workspace entry points follow the same public availability as /connect. */
export function ConnectionActions() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const stop = new AbortController();
    void readConnectionOffer(stop.signal).then(offer => { if (!stop.signal.aborted) setAvailable(offer.localHelper); }).catch(() => { if (!stop.signal.aborted) setAvailable(false); });
    return () => stop.abort();
  }, []);
  return available ? <div className="onboarding-start"><a className="button primary" href="/connect">Connect an agent</a><a className="button secondary" href="/claim">Enter a claim code</a></div>
    : <div className="onboarding-start"><a href="/connect">Check available connections</a></div>;
}
