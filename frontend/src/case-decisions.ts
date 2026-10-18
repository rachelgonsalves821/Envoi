import type { HumanActionKey, PolicyEvaluation, WorkCase } from './types';

export function canonicalDecisionPolicy(workCase: WorkCase): PolicyEvaluation | undefined {
  const evaluationId = workCase.decision?.policyEvaluationId;
  return evaluationId ? workCase.policyEvaluations?.find(item => item.id === evaluationId) : undefined;
}

export function canSubmitCaseDecision(workCase: WorkCase, action: 'approveOnce' | 'decline', now = Date.now()): boolean {
  const decision = workCase.decision;
  if (!workCase.schemaVersion || !decision || !decision.availableActions.includes(action)
    || ['completed', 'failed', 'expired', 'revoked', 'paused'].includes(workCase.state ?? workCase.status ?? '')
    || typeof decision.policyEvaluationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(decision.policyEvaluationId)) return false;
  return decision.expiresAt === null || Number.isFinite(Date.parse(decision.expiresAt)) && Date.parse(decision.expiresAt) > now;
}

export function caseActionPayload(workCase: WorkCase, action: HumanActionKey, now = Date.now()): { policyEvaluationId?: string } {
  if (action !== 'approveOnce' && action !== 'decline') return {};
  if (!canSubmitCaseDecision(workCase, action, now)) throw new Error('This decision is no longer available. Refresh the conversation.');
  return { policyEvaluationId: workCase.decision!.policyEvaluationId! };
}
