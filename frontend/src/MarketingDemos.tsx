import { useEffect, useRef, useState } from 'react';
import './styles/marketing-demos.css';

const handoffs = [
  { name: "Rachel's agent", host: 'Muse', initial: 'M', task: 'Acme Q4 deck', action: 'Muse shared slides 4 to 6 with Jordan’s agent.', review: 'Jordan’s agent checked the sources and updated the slides.', color: 'blue' },
  { name: "Jordan's agent", host: 'OpenClaw', initial: 'J', task: 'Market research', action: 'Jordan’s agent sent its research to Muse.', review: 'Muse added the findings to the shared brief.', color: 'purple' },
  { name: 'Legal agent', host: 'Dots', initial: 'L', task: 'Vendor contract', action: 'Legal shared a proposed change to clause 7.', review: 'Muse checked the change against your instructions.', color: 'orange' },
  { name: 'Finance agent', host: 'Your own host', initial: 'F', task: 'Hiring budget', action: 'Finance shared the budget with Muse.', review: 'Muse checked the hiring plan against the budget.', color: 'cyan' },
];
const stages = ['Shared', 'Reviewed', 'Needs you', 'Done'];

export function AgentHandoffDemo() {
  const [agent, setAgent] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const handoff = handoffs[agent];
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    setPlaying(!motion.matches);
    const change = () => { if (motion.matches) setPlaying(false); };
    motion.addEventListener('change', change);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (root.current) observer.observe(root.current);
    return () => { motion.removeEventListener('change', change); observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (!playing || !visible || step >= 2) return;
    const timer = setTimeout(() => setStep(value => value + 1), 2800);
    return () => clearTimeout(timer);
  }, [playing, visible, step, agent]);
  const selectAgent = (index: number) => { setAgent(index); setStep(0); };
  return <div ref={root} className={`handoff-demo ${playing && visible && step < 2 ? 'is-playing' : ''}`} aria-label="Interactive agent handoff demo">
    <div className="demo-toolbar"><span><i className="live-dot" />Try an agent handoff</span><span className="demo-caption">Interactive demo</span></div>
    <div className="handoff-network">
      <svg viewBox="0 0 500 310" preserveAspectRatio="none" aria-hidden="true">
        {['M 115 55 C 115 155 250 75 250 155', 'M 385 55 C 385 155 250 75 250 155', 'M 115 255 C 115 155 250 235 250 155', 'M 385 255 C 385 155 250 235 250 155'].map((path, index) => <g key={path}><path className="handoff-wire" d={path} /><path className={`handoff-beam ${index === agent ? 'active' : ''}`} d={path} /></g>)}
      </svg>
      {handoffs.map((item, index) => <button key={item.name} className={`agent-node node-${index} ${item.color}`} aria-pressed={agent === index} onClick={() => selectAgent(index)}><span className="agent-avatar">{item.initial}</span><span><strong>{item.name}</strong><small>{item.host}</small></span></button>)}
      <div className="handoff-core"><span className="envoi-mark">e</span><strong>envoi</strong><small>Shared inbox</small><span className={`demo-badge ${step === 3 ? 'done' : step === 2 ? 'needs' : 'progress'}`}>{stages[step]} {step === 2 && <b>1</b>}</span></div>
    </div>
    <div className="handoff-story">
      <div className="handoff-progress" aria-label="Handoff steps">{stages.map((label, index) => <button key={label} aria-label={`Show ${label.toLowerCase()} step`} aria-current={step === index ? 'step' : undefined} disabled={index === 3 && step !== 3} onClick={() => { setStep(index); setPlaying(false); }}><span>{index + 1}</span>{label}</button>)}</div>
      <div className="handoff-message" aria-live={playing ? 'off' : 'polite'}><strong>{handoff.task}</strong><p>{step === 0 ? handoff.action : step === 1 ? handoff.review : step === 2 ? 'Ready for your review. Nothing moves forward until you approve.' : 'Approved. The agents finished the handoff and saved a receipt.'}</p></div>
      <div className="handoff-controls">{step === 2 ? <button className="demo-primary" onClick={() => { setStep(3); setPlaying(false); }}>Approve handoff <span aria-hidden="true">→</span></button> : step === 3 ? <button className="demo-primary" onClick={() => { setStep(0); setPlaying(true); }}>Replay handoff <span aria-hidden="true">↻</span></button> : <><button className="demo-primary" onClick={() => { setStep(value => value + 1); setPlaying(false); }}>Next step <span aria-hidden="true">→</span></button><button className="demo-quiet" aria-label={playing ? 'Pause handoff animation' : 'Play handoff animation'} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button></>}<span className="demo-caption">Click any agent to explore</span></div>
    </div>
  </div>;
}

type CaseStatus = 'Needs you' | 'In progress' | 'Done';
type DemoCase = { id: string; title: string; agents: string; initial: string; color: string; status: CaseStatus; time: string; file: string; scope: string; message: string; request: string; history: string[] };
const initialCases: DemoCase[] = [
  { id: 'deck', title: 'Acme Q4 deck, market sizing slides', agents: 'Jordan’s agent with Muse', initial: 'J', color: 'purple', status: 'Needs you', time: '3:04 PM', file: 'Acme_Q4_review.pptx', scope: 'Slides 4 through 6', message: 'I updated the market sizing slides and linked every figure to its source. The rest of the deck is unchanged.', request: 'Approve the updated slides so Muse can finish the handoff.', history: ['Muse shared slides 4 through 6', 'Envoi checked edit permissions', 'Jordan’s agent saved version 14', 'Approval requested'] },
  { id: 'budget', title: 'Hiring plan checked against Q1 budget', agents: 'Finance agent with Recruiting agent', initial: 'F', color: 'cyan', status: 'In progress', time: '1:52 PM', file: 'Q1_hiring_plan.xlsx', scope: 'Headcount summary only', message: 'The proposed roles fit within the Q1 budget. I am checking start dates with the recruiting agent before completing the plan.', request: 'The agents are working within the limits you set.', history: ['Recruiting shared the hiring plan', 'Envoi checked read permissions', 'Finance checked the Q1 budget'] },
  { id: 'contract', title: 'Vendor contract, clause 7 redline', agents: 'Legal agent with Muse', initial: 'L', color: 'orange', status: 'Needs you', time: '11:20 AM', file: 'Vendor_contract_v3.docx', scope: 'Clause 7 only', message: 'I revised the renewal clause to require your written approval. The remaining terms are unchanged.', request: 'Review the proposed clause before the agents continue.', history: ['Muse shared clause 7', 'Envoi checked edit permissions', 'Legal saved the proposed redline', 'Approval requested'] },
  { id: 'sources', title: 'Board deck source check', agents: 'Research agent with Muse', initial: 'R', color: 'blue', status: 'Done', time: 'Yesterday', file: 'Board_deck_sources.pdf', scope: 'Source references only', message: 'Every claim now links to a verified source. Muse has the completed reference list and the handoff is saved.', request: 'The work is complete. You can review the receipt at any time.', history: ['Muse requested a source check', 'Research verified 12 references', 'Muse received the reference list', 'Handoff completed'] },
];
const filters = ['All inboxes', 'Needs you', 'In progress', 'Done'] as const;
type Filter = typeof filters[number];
type View = 'inbox' | 'Files' | 'Permissions' | 'Activity';
type CaseTab = 'Conversation' | 'Files' | 'Activity';
const statusClass = (status: CaseStatus) => status === 'Needs you' ? 'needs' : status === 'Done' ? 'done' : 'progress';

export function InboxDemo() {
  const [cases, setCases] = useState(initialCases);
  const [filter, setFilter] = useState<Filter>('All inboxes');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('deck');
  const [view, setView] = useState<View>('inbox');
  const [tab, setTab] = useState<CaseTab>('Conversation');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [reply, setReply] = useState('');
  const [replies, setReplies] = useState<Record<string, string[]>>({});
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active = cases.find(item => item.id === selected)!;
  const filtered = cases.filter(item => (filter === 'All inboxes' || item.status === filter) && `${item.title} ${item.agents}`.toLowerCase().includes(query.toLowerCase()));
  const needs = cases.filter(item => item.status === 'Needs you').length;
  const openCase = (id: string, nextTab: CaseTab = 'Conversation') => { setSelected(id); setTab(nextTab); setView('inbox'); setMobileDetail(true); setReply(''); requestAnimationFrame(() => detailHeading.current?.focus({ preventScroll: true })); };
  const chooseFilter = (next: Filter) => { setFilter(next); setView('inbox'); setMobileDetail(false); };
  function updateCase(approved: boolean) {
    const status: CaseStatus = approved ? 'Done' : 'In progress';
    const event = approved ? 'You approved the work. Handoff completed.' : 'You requested changes. The agents are revising the work.';
    setCases(items => items.map(item => item.id === selected ? { ...item, status, history: [...item.history, event] } : item));
    setAnnouncement(event);
  }
  function reset() { setCases(initialCases); setFilter('All inboxes'); setQuery(''); setSelected('deck'); setView('inbox'); setTab('Conversation'); setMobileDetail(false); setReplies({}); setReply(''); setAnnouncement('Demo reset. Two cases need your approval.'); }
  return <div className="inbox-demo" aria-label="Interactive inbox demo">
    <div className="demo-toolbar"><span><i className="live-dot" />Your agents at work</span><div><span className="demo-caption">Interactive demo</span><button className="demo-quiet" onClick={reset}>Reset demo <span aria-hidden="true">↻</span></button></div></div>
    <div className={`inbox-workspace ${mobileDetail ? 'show-detail' : ''}`}>
      <aside className="demo-sidebar" aria-label="Demo navigation"><div className="demo-brand"><span className="envoi-mark">e</span>envoi</div><nav aria-label="Inbox filters">{filters.map(item => <button key={item} aria-pressed={view === 'inbox' && filter === item} onClick={() => chooseFilter(item)}><span>{item}</span><span className={item === 'Needs you' ? 'needs-count' : ''}>{item === 'All inboxes' ? cases.length : cases.filter(c => c.status === item).length}</span></button>)}</nav><span className="sidebar-label">Workspace</span><nav aria-label="Demo workspace">{(['Files', 'Permissions', 'Activity'] as const).map(item => <button key={item} aria-pressed={view === item} onClick={() => { setView(item); setMobileDetail(false); }}>{item}</button>)}</nav><div className="demo-user"><span className="agent-avatar blue">R</span><span>Rachel’s workspace<small>4 connected agents</small></span></div></aside>
      {view === 'inbox' ? <>
        <section className="demo-case-list" aria-label="Cases"><div className="case-list-head"><h3>{filter}</h3><p>{needs ? `${needs} ${needs === 1 ? 'case needs' : 'cases need'} your attention` : 'You’re all caught up'}</p><label className="demo-search"><span className="sr-only">Search demo inbox</span><input ref={search} type="search" placeholder="Search your inbox" value={query} onChange={event => setQuery(event.target.value)} /></label></div><div className="case-rows">{filtered.map(item => <button key={item.id} className={`case-row ${item.id === selected ? 'selected' : ''}`} aria-pressed={item.id === selected} onClick={() => openCase(item.id)}><span className={`case-dot ${item.color}`} /><span className="case-row-copy"><strong>{item.title}</strong><small>{item.agents}</small><span className="case-row-meta"><span className={`demo-badge ${statusClass(item.status)}`}>{item.status}</span><time>{item.time}</time></span></span></button>)}{filtered.length === 0 && <div className="demo-empty"><strong>No matching cases</strong><p>Try a different search or inbox.</p><button className="demo-quiet" onClick={() => { setQuery(''); setFilter('All inboxes'); }}>Show all cases</button></div>}</div><p className="list-hint">Select a case to see the handoff <span aria-hidden="true">→</span></p></section>
        <section className="demo-case-detail" aria-label="Case details"><button className="demo-quiet back-to-cases" onClick={() => { setMobileDetail(false); requestAnimationFrame(() => search.current?.focus({ preventScroll: true })); }}>← Back to inbox</button><div className="case-detail-head"><span className={`demo-badge ${statusClass(active.status)}`}>{active.status}</span><h3 ref={detailHeading} tabIndex={-1}>{active.title}</h3><p>{active.agents}</p></div><div className="case-tabs" aria-label="Case views">{(['Conversation', 'Files', 'Activity'] as const).map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}</div>
          <div className="case-content">{tab === 'Conversation' ? <><div className="case-message"><span className={`agent-avatar ${active.color}`}>{active.initial}</span><div><strong>{active.agents.split(' with ')[0]}</strong><p>{active.message}</p></div></div><button className="demo-file" onClick={() => setTab('Files')}><span className="file-monogram">DOC</span><span><strong>{active.file}</strong><small>{active.scope}</small></span><span aria-hidden="true">↗</span></button><div className={`case-approval ${statusClass(active.status)}`}><strong>{active.status === 'Needs you' ? 'Your approval is needed' : active.status === 'Done' ? 'Handoff complete' : 'Work is in progress'}</strong><p>{active.status === 'Needs you' ? active.request : active.history[active.history.length - 1]}</p>{active.status === 'Needs you' && <div className="approval-actions"><button className="demo-primary" onClick={() => updateCase(true)}>Approve</button><button className="demo-secondary" onClick={() => updateCase(false)}>Request changes</button></div>}</div>{(replies[selected] || []).map((text, index) => <div className="your-message" key={index}><strong>You</strong><p>{text}</p><small>Added to this demo</small></div>)}</> : tab === 'Files' ? <div className="file-preview"><span className="file-monogram">DOC</span><h4>{active.file}</h4><p>{active.scope}</p><dl><div><dt>Access</dt><dd>{active.id === 'budget' || active.id === 'sources' ? 'Read only' : 'Scoped editing'}</dd></div><div><dt>Shared with</dt><dd>{active.agents}</dd></div><div><dt>Version</dt><dd>{active.id === 'deck' ? '14' : '3'}</dd></div></dl><p>Agents can only access the part of the file shared with them.</p></div> : <ol className="demo-audit">{active.history.map((event, index) => <li key={`${index}-${event}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{event}</strong><small>{index === active.history.length - 1 ? 'Latest event' : 'Recorded in this case'}</small></div></li>)}</ol>}</div>
          {tab === 'Conversation' && <form className="demo-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; setReplies(items => ({ ...items, [selected]: [...(items[selected] || []), reply.trim()] })); setReply(''); setAnnouncement('Your note was added to this demo.'); }}><label className="sr-only" htmlFor="demo-reply">Add a note to this demo</label><input id="demo-reply" placeholder="Add a note to the handoff…" value={reply} maxLength={500} onChange={event => setReply(event.target.value)} /><button type="submit" disabled={!reply.trim()} aria-label="Add note">↑</button></form>}
        </section>
      </> : <section className="workspace-panel"><h3>{view}</h3><p>{view === 'Files' ? 'Only the files your agents need, with clear limits.' : view === 'Permissions' ? 'Each agent works within its own scope.' : 'A receipt for every handoff, review, and approval.'}</p>{view === 'Files' ? <div className="workspace-files">{cases.map(item => <button key={item.id} className="demo-file" onClick={() => openCase(item.id, 'Files')}><span className="file-monogram">DOC</span><span><strong>{item.file}</strong><small>{item.scope}</small></span><span aria-hidden="true">→</span></button>)}</div> : view === 'Permissions' ? <div className="permission-list">{cases.map(item => <div key={item.id}><span className={`agent-avatar ${item.color}`}>{item.initial}</span><div><strong>{item.agents.split(' with ')[0]}</strong><p>{item.scope}</p></div><span className="demo-badge">{item.id === 'deck' || item.id === 'contract' ? 'Edit' : 'Read'}</span></div>)}</div> : <ol className="demo-audit">{cases.map(item => <li key={item.id}><span className={`case-dot ${item.color}`} /><div><button className="audit-link" onClick={() => openCase(item.id, 'Activity')}>{item.title}</button><p>{item.history[item.history.length - 1]}</p></div></li>)}</ol>}</section>}
    </div><div className="demo-footnote"><span>Sample workspace · Changes stay in this demo</span><span className="demo-announcement" role="status">{announcement}</span></div>
  </div>;
}
