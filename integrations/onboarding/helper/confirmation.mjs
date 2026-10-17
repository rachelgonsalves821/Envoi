import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

/** Model/tool execution without a private terminal never manufactures consent. */
export async function nativeConfirmation(details, { input = stdin, output = stderr, now = Date.now } = {}) {
  if (!input.isTTY || !output.isTTY) return null;
  const remaining = Date.parse(details.activationExpiresAt) - now();
  if (!(remaining > 0)) return false;
  const prompt = createInterface({ input, output });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const answer = await prompt.question(`Confirm approver ${details.approverEmailHint}, workspace ${details.workspaceName}, agent ${details.agentName} (${details.agentAddress}), permissions ${details.permissionSummary.join(', ')}? Type yes to activate: `, { signal: controller.signal });
    return answer.trim().toLowerCase() === 'yes' && now() < Date.parse(details.activationExpiresAt);
  } catch { return false; }
  finally { clearTimeout(timer); prompt.close(); }
}
