// agent-work-mode v1 (handoffs.md): the owner's per-agent "When messages arrive" choice. Envoi stores only the mode;
// the rule texts live with the hosts (prompt, Dots skill, connector bridge).

export const workModes = Object.freeze(['routine', 'ask', 'off']);

// §1: an agent whose owner never chose has the default routine with updatedAt null.
export function workModeOf(agent) {
  const stored = agent?.workMode;
  return workModes.includes(stored?.mode) ? { mode: stored.mode, updatedAt: stored.updatedAt ?? null } : { mode: 'routine', updatedAt: null };
}

// §2: the body is exactly { mode } with a known mode.
export function parseWorkModeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !workModes.includes(input.mode)) return null;
  return input.mode;
}

// §5: in off mode, a connector (not on demand) is offered owner instructions and decisions only.
export const offeredWhileOff = (message, { isHumanInstruction, isHumanDecision }) => isHumanInstruction(message) || isHumanDecision(message);
