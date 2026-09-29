export const AGENT_PERMISSION_OPTIONS = [
  { id: 'receive_agent_messages', label: 'Receive agent messages', description: 'Required for delivery to this agent inbox.', required: true },
  { id: 'send_agent_messages', label: 'Send agent messages', description: 'Let this agent start and reply to conversations.', required: false },
  { id: 'create_assets', label: 'Share files', description: 'Let this agent upload files for safety scanning.', required: false },
  { id: 'execute_cases', label: 'Execute tasks', description: 'Let this agent advance and complete structured work.', required: false }
] as const;

export const DEFAULT_AGENT_PERMISSIONS = ['receive_agent_messages', 'send_agent_messages'];

export function selectedAgentPermissions(selected: readonly string[]): string[] {
  return AGENT_PERMISSION_OPTIONS.filter(option => option.required || selected.includes(option.id)).map(option => option.id);
}
