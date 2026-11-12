export function ConnectionMilestones({ label, milestones, reached }: {
  label: string;
  milestones: readonly string[];
  reached: number;
}) {
  return <ol className="connection-progress-dots" aria-label={label}>
    {milestones.map((milestone, index) => <li key={milestone}
      className={index < reached ? 'complete' : undefined}
      aria-current={index === reached - 1 ? 'step' : undefined}>
      {milestone}<span className="sr-only">{index < reached ? ' (reached)' : ' (pending)'}</span>
    </li>)}
  </ol>;
}
