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

export { default as InboxDemo } from './StagingInboxDemo';
