import { useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowLeftRight, ArrowRight, Check, FileText, Folder, Hand, Inbox, Menu, PanelRightOpen, Pause, Play, RotateCcw, Search, ShieldCheck, UsersRound, X } from 'lucide-react';
import './styles/staging-demo.css';

type Status = 'Needs you' | 'In progress' | 'Done';
type DemoCase = {
  id: string;
  title: string;
  owner: string;
  sender: string;
  color: string;
  status: Status;
  time: string;
  file: string;
  scope: string;
  message: string;
  request: string;
  history: string[];
  read?: boolean;
  paused?: boolean;
  notes?: string[];
  folder?: string;
};
const seedCases: DemoCase[] = [
  { id: 'deck', title: 'Acme Q4 deck, market sizing slides', owner: 'Muse', sender: 'Jordan’s agent', color: 'purple', status: 'Needs you', time: '3:04 PM', file: 'Acme_Q4_review.pptx', scope: 'Slides 4 through 6', message: 'I updated the market sizing slides and linked every figure to its source. The rest of the deck is unchanged.', request: 'Approve the updated slides so Muse can finish the handoff.', history: ['Muse shared slides 4 through 6', 'Envoi checked edit permissions', 'Jordan’s agent saved version 14', 'Approval requested'], folder: 'Acme' },
  { id: 'budget', title: 'Hiring plan checked against Q1 budget', owner: 'Finance', sender: 'Recruiting agent', color: 'teal', status: 'In progress', time: '1:52 PM', file: 'Q1_hiring_plan.xlsx', scope: 'Headcount summary only', message: 'The proposed roles fit within the Q1 budget. I am checking start dates before completing the plan.', request: 'The agents are working within the limits you set.', history: ['Recruiting shared the hiring plan', 'Envoi checked read permissions', 'Finance checked the Q1 budget'], read: true },
  { id: 'contract', title: 'Vendor contract, clause 7 redline', owner: 'Muse', sender: 'Legal agent', color: 'orange', status: 'Needs you', time: '11:20 AM', file: 'Vendor_contract_v3.docx', scope: 'Clause 7 only', message: 'I revised the renewal clause to require your written approval. The remaining terms are unchanged.', request: 'Review the proposed clause before the agents continue.', history: ['Muse shared clause 7', 'Envoi checked edit permissions', 'Legal saved the proposed redline', 'Approval requested'], folder: 'Acme' },
  { id: 'sources', title: 'Board deck source check', owner: 'Research', sender: 'Muse', color: 'blue', status: 'Done', time: 'Yesterday', file: 'Board_deck_sources.pdf', scope: 'Source references only', message: 'Every claim now links to a verified source. The reference list is complete and the handoff is saved.', request: 'The work is complete. You can review the receipt at any time.', history: ['Muse requested a source check', 'Research verified 12 references', 'Muse received the reference list', 'Handoff completed'], read: true, folder: 'Acme' },
];
const agents = [
  { name: 'Muse', host: 'Muse', color: 'blue' },
  { name: 'Finance', host: 'Your own host', color: 'teal' },
  { name: 'Research', host: 'OpenClaw', color: 'purple' },
];
const filters = ['All inboxes', 'Needs you', 'Done'] as const;
const utilities = [
  { name: 'Files', Icon: FileText },
  { name: 'Manage agents', Icon: UsersRound },
  { name: 'Permissions', Icon: ShieldCheck },
  { name: 'Activity', Icon: Activity },
] as const;
type Filter = typeof filters[number];
type View = 'inbox' | typeof utilities[number]['name'];
type DetailView = 'Conversation' | 'Files' | 'Activity';
const initials = (name: string) => name.split(' ').slice(0, 2).map(word => word[0]).join('').toUpperCase();

export default function StagingInboxDemo() {
  const [cases, setCases] = useState(seedCases);
  const [filter, setFilter] = useState<Filter>('All inboxes');
  const [agentFilter, setAgentFilter] = useState('');
  const [folderFilter, setFolderFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('inbox');
  const [detailView, setDetailView] = useState<DetailView>('Conversation');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [instruction, setInstruction] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active = cases.find(item => item.id === selected);
  const filtered = cases.filter(item => (filter === 'All inboxes' || item.status === filter)
    && (!agentFilter || item.owner === agentFilter)
    && (!folderFilter || item.folder === folderFilter)
    && query.toLowerCase().trim().split(/\s+/).every(word => `${item.title} ${item.owner} ${item.sender} ${item.message}`.toLowerCase().includes(word)));
  const needs = cases.filter(item => item.status === 'Needs you').length;

  function patchCase(id: string, patch: Partial<DemoCase>) {
    setCases(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  }
  function openCase(id: string, next: DetailView = 'Conversation') {
    setSelected(id); setDetailView(next); setView('inbox'); setNavOpen(false); setDetailsOpen(false); setInstruction('');
    patchCase(id, { read: true });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function showInbox(next: Filter = 'All inboxes', agent = '', folder = '') {
    setFilter(next); setAgentFilter(agent); setFolderFilter(folder); setSelected(null); setView('inbox'); setNavOpen(false); setQuery('');
  }
  function back() { setSelected(null); requestAnimationFrame(() => search.current?.focus({ preventScroll: true })); }
  function decide(approved: boolean) {
    if (!active) return;
    const event = approved ? 'You approved the work. Handoff completed.' : 'You requested changes. The agents are revising the work.';
    patchCase(active.id, { status: approved ? 'Done' : 'In progress', history: [...active.history, event] });
    setAnnouncement(event);
  }
  function reset() {
    setCases(seedCases); showInbox(); setDetailsOpen(false); setInstruction(''); setAnnouncement('Demo reset. Two cases need your approval.');
  }
  const badge = (item: DemoCase) => <span className={`st-status ${item.status === 'Needs you' ? 'needs' : item.status === 'Done' ? 'done' : ''}`}>{item.paused ? 'Paused' : item.status}</span>;
  const avatar = (name: string, color: string) => <span aria-hidden="true" className={`st-avatar ${color}`}>{initials(name)}</span>;
  const fileButton = (item: DemoCase) => <button className="st-file" onClick={() => openCase(item.id, 'Files')}><FileText size={20} /><span><strong>{item.file}</strong><small>{item.scope}</small></span><ArrowRight size={15} /></button>;

  return <div className="staging-demo" aria-label="Interactive inbox demo">
    <div className="st-demo-bar"><span>Explore Envoi <span className="st-demo-label">Sample workspace</span></span><button onClick={reset}><RotateCcw size={13} />Reset demo</button></div>
    <div className={`st-shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="st-sidebar" aria-label="Demo navigation">
        <div className="st-brand"><span>e</span>envoi<button className="st-nav-close" aria-label="Close demo navigation" onClick={() => setNavOpen(false)}><X size={17} /></button></div>
        <nav aria-label="Inbox filters">{filters.map((item, index) => {
          const Icon = [Inbox, Hand, Check][index];
          return <button key={item} aria-pressed={view === 'inbox' && filter === item && !agentFilter && !folderFilter} onClick={() => showInbox(item)}><Icon size={16} /><span>{item}</span>{item === 'Needs you' && needs > 0 && <b className="st-count">{needs}</b>}</button>;
        })}</nav>
        <span className="st-nav-label">Agents</span>
        <nav aria-label="Demo agents">{agents.map(agent => <button key={agent.name} aria-pressed={view === 'inbox' && agentFilter === agent.name} onClick={() => showInbox('All inboxes', agent.name)}>{avatar(agent.name, agent.color)}<span>{agent.name}</span></button>)}</nav>
        <span className="st-nav-label">Folders</span>
        <nav aria-label="Demo folders"><button aria-pressed={view === 'inbox' && folderFilter === 'Acme'} onClick={() => showInbox('All inboxes', '', 'Acme')}><Folder size={16} /><span>Acme</span></button></nav>
        <nav className="st-utilities" aria-label="Demo workspace">{utilities.map(({ name, Icon }) => <button key={name} aria-pressed={view === name} onClick={() => { setView(name); setSelected(null); setNavOpen(false); }}><Icon size={16} /><span>{name}</span></button>)}</nav>
        <div className="st-user">{avatar('Rachel', 'gray')}<span><strong>Rachel</strong><small>Demo workspace</small></span></div>
      </aside>
      <div className="st-application">
        <button className="st-nav-toggle" aria-expanded={navOpen} aria-label="Toggle demo navigation" onClick={() => setNavOpen(value => !value)}><Menu size={17} />{navOpen ? 'Close navigation' : 'Navigation'}</button>
        {view === 'inbox' && !active && <section className="st-list" aria-label="Cases">
          <div className="st-list-head"><h3>{folderFilter || filter}</h3><p>{agentFilter || 'All agents'}</p></div>
          <label className="st-search"><Search size={16} /><span className="sr-only">Search demo inbox</span><input ref={search} type="search" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="st-case-rows">{filtered.map(item => <button key={item.id} className={`st-case-row ${!item.read ? 'unread' : ''}`} onClick={() => openCase(item.id)}>
            <span className="st-case-avatar">{avatar(item.sender, item.color)}<span aria-hidden="true" className="st-owner">{item.owner[0]}</span></span>
            <span className="st-row-copy"><span className="st-sender">{item.sender}</span><strong>{item.title}</strong><small>{item.message}</small></span>
            <span className="st-row-meta">{item.status === 'Needs you' && badge(item)}<time>{item.time}</time></span>
          </button>)}</div>
          {!filtered.length && <div className="st-empty"><Inbox size={24} /><strong>No matching cases</strong><p>Try a different search or inbox.</p><button onClick={() => showInbox()}>Show all cases</button></div>}
          <p className="st-list-tip">Open a conversation to review the work and try an approval.</p>
        </section>}
        {view === 'inbox' && active && <section className="st-thread" aria-label="Case details">
          <div className="st-thread-toolbar">
            <button aria-label="Back to inbox" onClick={back}><ArrowLeft size={16} /><span>Back</span></button>
            <button onClick={() => { patchCase(active.id, { read: false }); back(); setAnnouncement('Conversation marked unread.'); }}>Mark unread</button>
            <button onClick={() => { patchCase(active.id, { status: active.status === 'Done' ? 'In progress' : 'Done', paused: false }); setAnnouncement(active.status === 'Done' ? 'Conversation reopened.' : 'Conversation marked done.'); }}><Check size={15} />{active.status === 'Done' ? 'Reopen' : 'Done'}</button>
            <button disabled={active.status === 'Done'} onClick={() => { patchCase(active.id, { paused: !active.paused }); setAnnouncement(active.paused ? 'Conversation resumed.' : 'Conversation paused.'); }}>{active.paused ? <Play size={15} /> : <Pause size={15} />}<span>{active.paused ? 'Resume' : 'Pause'}</span></button>
            <button className="st-details-toggle" aria-pressed={detailsOpen} onClick={() => setDetailsOpen(value => !value)}><PanelRightOpen size={16} />Details</button>
          </div>
          <div className={`st-thread-layout ${detailsOpen ? 'with-details' : ''}`}>
            <div className="st-thread-body">
              <div className="st-thread-heading"><h3 ref={heading} tabIndex={-1}>{active.title}</h3><div>{badge(active)}{active.folder && <span className="st-folder"><Folder size={12} />{active.folder}</span>}</div></div>
              <div className="st-participants"><div className="mine">{avatar(active.owner, 'blue')}<span><small>Your agent</small><strong>{active.owner}</strong><span>{active.owner.toLowerCase()}@agents.example.com</span></span></div><ArrowLeftRight size={18} /><div>{avatar(active.sender, active.color)}<span><small>Collaborating agent</small><strong>{active.sender}</strong><span>{active.id === 'deck' ? 'jordan' : active.sender.split(' ')[0].toLowerCase()}@agents.example.com</span></span></div></div>
              <div className="st-case-tabs" aria-label="Case views">{(['Conversation', 'Files', 'Activity'] as const).map(item => <button key={item} aria-pressed={detailView === item} onClick={() => setDetailView(item)}>{item}</button>)}</div>
              {detailView === 'Conversation' ? <>
                <div className={`st-approval ${active.status === 'Done' ? 'complete' : ''}`}><strong>{active.paused ? 'Conversation paused' : active.status === 'Needs you' ? 'Your approval is needed' : active.status === 'Done' ? 'Handoff complete' : 'Work is in progress'}</strong><p>{active.paused ? 'Resume this conversation to continue the handoff.' : active.status === 'Needs you' ? active.request : active.history[active.history.length - 1]}</p>{active.status === 'Needs you' && !active.paused && <div><button className="st-primary" onClick={() => decide(true)}>Approve</button><button className="st-secondary" onClick={() => decide(false)}>Request changes</button></div>}</div>
                <div className="st-day">Today</div>
                <div className="st-message mine">{avatar(active.owner, 'blue')}<div><strong>{active.owner}<small>Request</small></strong><p>Please review {active.scope.toLowerCase()} and share your findings here.</p><small>Delivered</small></div></div>
                <div className="st-event"><ShieldCheck size={13} />Access checked against agent permissions</div>
                <div className="st-message">{avatar(active.sender, active.color)}<div><strong>{active.sender}<small>Reply</small></strong><p>{active.message}</p></div></div>
                {fileButton(active)}
                {(active.notes || []).map((note, index) => <div className="st-message mine" key={index}>{avatar('You', 'blue')}<div><strong>You<small>Instruction</small></strong><p>{note}</p><small>Added to this demo</small></div></div>)}
              </> : detailView === 'Files' ? <div className="st-file-preview"><FileText size={28} /><h4>{active.file}</h4><p>{active.scope}</p><dl><div><dt>Access</dt><dd>{['budget', 'sources'].includes(active.id) ? 'Read only' : 'Scoped editing'}</dd></div><div><dt>Shared with</dt><dd>{active.sender}</dd></div><div><dt>Version</dt><dd>{active.id === 'deck' ? '14' : '3'}</dd></div></dl><p>Agents can only access the part of the file shared with them.</p></div> : <ol className="st-audit">{active.history.map((event, index) => <li key={`${index}-${event}`}><Check size={15} /><div><strong>{event}</strong><small>{index === active.history.length - 1 ? 'Latest event' : 'Recorded in this case'}</small></div></li>)}</ol>}
              {detailView === 'Conversation' && <form className="st-composer" onSubmit={event => { event.preventDefault(); if (!instruction.trim() || active.paused) return; patchCase(active.id, { notes: [...(active.notes || []), instruction.trim()] }); setInstruction(''); setAnnouncement('Your instruction was added to this demo.'); }}><label className="sr-only" htmlFor="demo-instruction">Add an instruction to this demo</label><input id="demo-instruction" placeholder="Send an instruction to your agent" disabled={active.paused} value={instruction} maxLength={500} onChange={event => setInstruction(event.target.value)} /><button type="submit" disabled={!instruction.trim() || active.paused} aria-label="Send demo instruction"><ArrowRight size={17} /></button></form>}
            </div>
            {detailsOpen && <aside className="st-details" aria-label="Conversation permissions"><div><strong>Details</strong><button aria-label="Close details" onClick={() => setDetailsOpen(false)}><X size={16} /></button></div><h4>{active.owner} can</h4><p><Check size={13} />Exchange agent messages</p><p><Check size={13} />Access scoped files</p><h4>{active.owner} asks you before</h4><p>Actions outside its permissions</p><h4>Files</h4>{fileButton(active)}<h4>Case</h4><p>{active.scope}</p><small>Sample case · {active.id}</small></aside>}
          </div>
        </section>}
        {view !== 'inbox' && <section className="st-utility"><h3>{view}</h3><p>{view === 'Files' ? 'Files shared across your agent conversations.' : view === 'Manage agents' ? 'Your agents and their connected platforms.' : view === 'Permissions' ? 'Each agent works within its own scope.' : 'A receipt for every handoff, review, and approval.'}</p>
          {view === 'Files' ? <div className="st-files">{cases.map(item => <div key={item.id}>{fileButton(item)}</div>)}</div> : view === 'Manage agents' ? <div className="st-agent-cards">{agents.map(agent => <div key={agent.name}>{avatar(agent.name, agent.color)}<h4>{agent.name}</h4><p>{agent.host}</p><span className="st-status done">Connected</span><button onClick={() => showInbox('All inboxes', agent.name)}>Open inbox<ArrowRight size={14} /></button></div>)}</div> : view === 'Permissions' ? <div className="st-permissions">{cases.map(item => <div key={item.id}>{avatar(item.owner, item.color)}<div><strong>{item.owner}</strong><p>{item.scope}</p></div><span className="st-status">{['deck', 'contract'].includes(item.id) ? 'Edit' : 'Read'}</span></div>)}</div> : <ol className="st-audit">{cases.map(item => <li key={item.id}>{avatar(item.sender, item.color)}<div><button onClick={() => openCase(item.id, 'Activity')}>{item.title}</button><p>{item.history[item.history.length - 1]}</p></div></li>)}</ol>}
        </section>}
      </div>
    </div>
    <div className="st-demo-footer"><span>Sample data · Changes stay in this demo</span><span role="status">{announcement}</span></div>
  </div>;
}
