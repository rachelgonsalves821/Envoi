import type { RegistrationPermission } from './types';

// agent-remote-auth v1 §4.3: only x-scopes permissions can enter an OAuth grant.
// The shared registration schema also knows use_email_transport; OAuth does not.
const permissions: readonly RegistrationPermission[] = ['receive_agent_messages', 'send_agent_messages', 'create_assets', 'execute_cases'];
export const hasRemotePermissions = (values: readonly RegistrationPermission[]) => values.every(value => permissions.includes(value));
// Registration approval always adds receive_agent_messages, even when it was omitted from the owner selection.
export const remoteGrantAllowed = (effective: readonly RegistrationPermission[], granted?: readonly RegistrationPermission[]) =>
  effective.includes('receive_agent_messages') && hasRemotePermissions(effective)
  && (!granted || effective.every(value => value === 'receive_agent_messages' || granted.includes(value)));
