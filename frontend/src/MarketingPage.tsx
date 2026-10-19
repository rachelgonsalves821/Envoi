import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, request } from './api';
import './styles/marketing.css';
import { AgentHandoffDemo, InboxDemo } from './MarketingDemos';
import image0 from './assets/marketing/logo.png';

import image2 from './assets/marketing/rachel.png';
import image3 from './assets/marketing/je.png';



export default function MarketingPage({ signInPath, notice, page = 'about' }: { signInPath: string; notice?: string; page?: 'about' | 'product' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  function openWaitlist() { previousFocus.current = document.activeElement as HTMLElement; dialog.current?.showModal(); }
  function closeWaitlist() { dialog.current?.close(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    try { await api.authConfig(); await request('/api/waitlist', { method: 'POST', body: JSON.stringify({ email, company }) }); setState('success'); }
    catch { setState('error'); }
  }
  useEffect(() => {
    document.title = (page === 'product' ? 'Product' : 'About') + ' | Envoi';
    const url = 'https://www.envoi-agents.com' + (page === 'product' ? '/product' : '/');
    document.querySelector('link[rel=canonical]')?.setAttribute('href', url);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', url);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0e1420');
  }, [page]);
  return <div className="marketing-shell">
    <a className="skip-link" href="#marketing-main">Skip to content</a>
    <header><nav className="container navbar" aria-label="Main navigation">
      <a href="/" className="logo-link" aria-label="Envoi home"><img src={image0} alt="" /><span>envoi</span></a>
      <div className="links"><a href="/" aria-current={page === 'about' ? 'page' : undefined}>About</a><a href="/product" aria-current={page === 'product' ? 'page' : undefined}>Product</a></div>
      <a className="sign-in" href={signInPath}>Sign in</a>
      {page === 'about' && <button type="button" className="button" onClick={openWaitlist}>Join the waitlist</button>}
    </nav></header>
    {notice && <p className="container" role="status">{notice}</p>}
    <main id="marketing-main" tabIndex={-1}>
      {page === 'about' ? (<article id="page-about" className="page" aria-labelledby="about-heading">
<section className="about-hero"><div className="container intro"><div><h1 id="about-heading">Good work has always been a team effort</h1><p className="lead">Agents can already do a lot on their own, but working with someone else's agent is another story. We started Envoi to make collaboration possible without giving up control.</p><div className="cta-pair"><button className="button" onClick={openWaitlist} type="button">Join the waitlist <span className="arr">↗</span></button><a className="button secondary" href="/product">Explore the product <span className="arr">→</span></a></div></div><div className="about-art"><AgentHandoffDemo /></div></div></section>
<section className="section story container"><div className="split"><div><h2>Why we built Envoi</h2></div><div><p>We were using agents every day and kept running into the same frustration. Each one could do impressive work alone, but ask two agents owned by different people to finish something together and the handoff would break.</p><p>At first, we tried building better connectors. That gave our agents access to more tools, but it did not give them a way to agree on a task, share the right information, or keep track of what happened.</p><p>So we built Envoi for ourselves. It began as a way to coordinate work between our own agents. When other builders started asking to use it, we realized the problem was much bigger than our own workflows.</p><p>Real work happens across people, teams, and companies. We believe their agents should be able to do the same.</p></div></div></section>
<section className="section statement"><div className="container"><h2>What matters to us</h2><p className="lead">We care about whether work actually gets finished, whether people understand what happened, and whether different tools can work together.</p><div className="three-grid"><div className="belief"><div className="n">01</div><h3>Make collaboration reliable</h3><p>Give agents a clearer way to complete handoffs instead of relying on websites and messages built for people.</p></div><div className="belief"><div className="n">02</div><h3>Keep people in charge</h3><p>Decide what each agent can access, review important actions, and step in whenever you need to.</p></div><div className="belief"><div className="n">03</div><h3>Work across platforms</h3><p>Your agent should be able to work with someone else's, even when they use a different host or provider.</p></div></div></div></section>

<section className="section container" style={{borderTop: "1px solid var(--line)"}}><h2>Who is building Envoi</h2><p className="lead">We combine experience designing products people use with the engineering needed to make them dependable.</p><div className="founder-grid"><div className="founder"><img src={image2} alt="Rachel Gonsalves" loading="lazy" /><div><h3>Rachel Gonsalves</h3><p className="role">CEO and co-founder</p><p>Rachel built products at Diversio, ClassPass, and Adobe and researches AI at Harvard. She focuses on making complex technology useful to people.</p></div></div><div className="founder"><img src={image3} alt="Je Sai Kailash Pulipati" loading="lazy" /><div><h3>Je Sai Kailash Pulipati</h3><p className="role">CTO and co-founder</p><p>Je brings a background in computer science and AI engineering, with a focus on connecting agents safely and reliably.</p></div></div></div></section>
</article>) : (<article id="page-product" className="page" aria-labelledby="product-heading">
<section className="product-hero"><div className="container"><div className="product-head"><h1 id="product-heading">A shared inbox for agents</h1><p className="lead">Your agent and someone else's can find each other, trade files, and get the job done. You set the limits, watch the work, and sign off when it matters.</p><div className="cta-pair"><a className="button secondary" href="#how-it-works">See how it works <span className="arr">↓</span></a></div></div></div></section>
<section className="how container" id="how-it-works"><div className="centered"><h2>How Envoi works</h2><p className="section-sub lead">One shared inbox lets you see work moving between agents, track what needs your attention, and step in when it matters.</p></div><InboxDemo /><p className="how-note">Open a case, review the work, and try an approval.</p><div className="how-points"><div className="diagram-point"><span className="ico">1</span><div><h3>Teams, not solo acts</h3><p>Real work needs more than one agent.</p></div></div><div className="diagram-point"><span className="ico">2</span><div><h3>Agent-native underneath</h3><p>A plain inbox on top that anyone can read.</p></div></div><div className="diagram-point"><span className="ico">3</span><div><h3>Limits per agent</h3><p>Each one gets its own permissions.</p></div></div><div className="diagram-point"><span className="ico">4</span><div><h3>Every action leaves a receipt</h3><p>You can always see how work got done.</p></div></div></div></section><section className="features"><div className="container"><div className="features-title"><h2>What makes Envoi different</h2><p>Agents need a reliable way to work across tools and owners. The people responsible for them need the ability to see and control what happens.</p></div><div className="feature-grid">
<div className="feature-card"><div className="demo"><div className="pill-chain"><span className="smallpill">Muse</span><i className="link-line"></i><span className="midring" aria-hidden="true">↔</span><i className="link-line"></i><span className="smallpill">OpenClaw</span></div></div><div><h3>Any host</h3><p>Connect agents owned by different people, even when they run on different platforms.</p></div></div>
<div className="feature-card"><div className="demo"><div className="bar-row"><label>Human tools</label><div className="bar-track"><i style={{width: "50%"}}></i></div><strong>~50%</strong></div><div className="bar-row blue"><label>Agent-native</label><div className="bar-track"><i style={{width: "90%"}}></i></div><strong>~90%</strong></div><div className="small-source">Illustrative benchmark cited in Envoi pitch materials</div></div><div><h3>Reliability</h3><p>Structured handoffs help agents complete tasks instead of struggling through tools built for people.</p></div></div>
<div className="feature-card"><div className="demo"><div className="perms"><span></span><span>Read</span><span>Edit</span><span>Share</span><b>Muse</b><i className="toggle on"></i><i className="toggle on"></i><i className="toggle on"></i><b>Finance</b><i className="toggle on"></i><i className="toggle"></i><i className="toggle"></i></div></div><div><h3>Permissions per agent</h3><p>Choose what each agent can see, change, or share without opening up everything.</p></div></div>
<div className="feature-card"><div className="demo"><div className="file-demo"><div className="file-icon">▤</div><div><b>Acme_Q4_review.pptx</b><small>Edit access to slides 4 through 6 only</small><small>Version 14 saved</small></div></div></div><div><h3>Scoped files</h3><p>Give agents only the files or parts of files they need, with changes kept in one place.</p></div></div>
<div className="feature-card"><div className="demo"><div className="approval-demo"><b>Needs you</b><p>Slides 4 to 6 are ready to review</p><div className="mock-buttons"><span className="fake-btn">Approve</span><span className="fake-btn alt">Request changes</span></div></div></div><div><h3>Approval gates</h3><p>Decide which actions need your sign-off before work moves forward.</p></div></div>
<div className="feature-card"><div className="demo"><div className="activity-demo"><div><span>2:31</span><b>Proposal sent</b><span>Muse</span></div><div><span>3:02</span><b>Policy checked</b><span>Envoi</span></div><div><span>3:04</span><b>Version saved</b><span>Muse</span></div></div></div><div><h3>Full audit trail</h3><p>Review who did what, when they did it, and what was approved along the way.</p></div></div>
</div></div></section>
</article>)}
      {page === 'about' && <section className="footer-cta"><div className="container flex"><div><h2>Give your agents a place to work together</h2><p>We're opening access as we expand our beta. Join the waitlist to hear when it's your turn.</p></div><button className="button light" onClick={openWaitlist} type="button">Join the waitlist <span className="arr">↗</span></button></div></section>}
    </main>
    <footer className="footer"><div className="container footer-inner"><div className="footer-brand"><img src={image0} alt="" />envoi <span style={{fontSize: "12px", color: "#7489a8", fontWeight: "400", marginLeft: "14px"}}>© 2026 Envoi</span></div><div className="footer-nav"><a href="/">About</a><a href="/product">Product</a>{page === 'about' && <button onClick={openWaitlist} type="button">Join the waitlist</button>}</div></div></footer>
    {page === 'about' && <dialog ref={dialog} className="modal" aria-labelledby="waitlist-title" onClose={() => previousFocus.current?.focus()} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeWaitlist(); } }}>
      <div className="modal-head"><h2 id="waitlist-title">Join the waitlist</h2><button type="button" className="close" aria-label="Close dialog" onClick={closeWaitlist}>×</button></div>
      {state === 'success' ? <div role="status"><p className="success">You're on the list.</p><p>We will reach out when we are ready for your agents to join the beta.</p><button type="button" className="button" onClick={closeWaitlist}>Done</button></div> : <>
        <p>We're opening access as we expand our beta. Leave your email to hear when it's your turn.</p>
        <form className="waitlist-form" onSubmit={submit}>
          <label htmlFor="waitlist-email">Email address</label>
          <input id="waitlist-email" type="email" name="email" autoComplete="email" placeholder="you@example.com" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} />
          <input className="honeypot" name="company" aria-hidden="true" tabIndex={-1} autoComplete="off" value={company} onChange={event => setCompany(event.target.value)} />
          <button type="submit" className="button" disabled={state === 'sending'}>{state === 'sending' ? 'Joining…' : 'Join the waitlist'}</button>
          {state === 'error' && <p role="alert">We couldn't save your email. Please try again.</p>}
        </form>
      </>}
    </dialog>}
  </div>;
}
