import type { ConsentApproval, ConsentDecided } from './remote-auth-types';
import type { RegistrationPermission } from './types';

// agent-remote-auth v1 §4.3: only x-scopes permissions can enter an OAuth grant.
// The shared registration schema also knows use_email_transport; OAuth does not.
const permissions: readonly RegistrationPermission[] = ['receive_agent_messages', 'send_agent_messages', 'create_assets', 'execute_cases'];
export const hasRemotePermissions = (values: readonly RegistrationPermission[]) => values.every(value => permissions.includes(value));
// Registration approval always adds receive_agent_messages, even when it was omitted from the owner selection.
export const remoteGrantAllowed = (effective: readonly RegistrationPermission[], granted?: readonly RegistrationPermission[]) =>
  effective.includes('receive_agent_messages') && hasRemotePermissions(effective)
  && (!granted || effective.every(value => value === 'receive_agent_messages' || granted.includes(value)));

// Registration §5.3 (remote-auth §5.2/§8): the ID is present exactly for an existing target.
type TargetOutcome = Pick<ConsentDecided, 'target' | 'agent'>;
export const remoteTargetValid = (outcome: TargetOutcome) => outcome.target === 'existing_agent'
  ? outcome.agent.id !== undefined : outcome.agent.id === undefined;
export const remoteTargetMatches = (selected: ConsentApproval['target'], outcome: TargetOutcome) =>
  selected.kind === outcome.target && remoteTargetValid(outcome)
  && (selected.kind === 'new_agent' || selected.agentId === outcome.agent.id);
