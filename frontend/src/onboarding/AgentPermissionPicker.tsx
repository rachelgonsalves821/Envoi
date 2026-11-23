import { AGENT_PERMISSION_OPTIONS, selectedAgentPermissions } from '../agent-permissions';

export function AgentPermissionPicker({ selected, onChange }: { selected: string[]; onChange?: (permissions: string[]) => void }) {
  return <fieldset className="permission-set"><legend>Agent permissions</legend>
    {AGENT_PERMISSION_OPTIONS.map(option => <label key={option.id} className="permission-switch-row">
      <input type="checkbox" checked={option.required || selected.includes(option.id)} disabled={option.required || !onChange}
        onChange={event => onChange?.(selectedAgentPermissions(event.target.checked ? [...selected, option.id] : selected.filter(permission => permission !== option.id)))} />
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
    </label>)}
  </fieldset>;
}
