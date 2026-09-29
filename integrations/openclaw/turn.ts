import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { parseAgentReply, workPrompt, type AgentTurn } from '../agent-bridges/bridge';

type History = (caseId: string) => Promise<Array<Record<string, unknown>>>;

export interface OpenClawTurnOptions {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  history?: History;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowSinaloaMcpWrites?: boolean;
  assetHandles?: Array<{ handle: string; filename: string }>;
}

export function mcpReplyMessageId(name: string, args: Record<string, unknown>): string | null {
  if (!['sinaloa_send_message', 'sinaloa_send_proposal', 'sinaloa_send_decision'].includes(name)) return null;
  const key = args.idempotencyKey;
  const match = typeof key === 'string' ? /^bridge:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):reply:1$/.exec(key) : null;
  return match?.[1] ?? null;
}

/** A completed MCP reply wins over Gateway text or a transient Gateway failure. */
export function withRecordedMcpReply(turn: AgentTurn, wasSent: (messageId: string) => Promise<boolean>): AgentTurn {
  return async (message, signal) => {
    if (await wasSent(message.id)) return { stop: true };
    try {
      const reply = await turn(message, signal);
      return await wasSent(message.id) ? { stop: true } : reply;
    } catch (error) {
      if (await wasSent(message.id)) return { stop: true };
      throw error;
    }
  };
}

function gatewayOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('OpenClaw Gateway requires HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('OpenClaw Gateway URL must be an origin without credentials or a path');
  }
  return url.origin;
}

/** Dispatches one fenced Sinaloa work item to a configured OpenClaw agent. */
export function openClawTurn(options: OpenClawTurnOptions): AgentTurn {
  const origin = gatewayOrigin(options.gatewayUrl);
  if (!options.gatewayToken) throw new TypeError('OpenClaw Gateway token is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.agentId)) throw new TypeError('A configured OpenClaw agent ID is required');
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new RangeError('timeoutMs must be from 1 to 1800000');
  const fetcher = options.fetch || fetch;

  return async (message: WorkMessage, signal: AbortSignal) => {
    const history = message.caseId && options.history ? await options.history(message.caseId) : [];
    if (signal.aborted) throw new Error('OpenClaw turn was canceled');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${origin}/v1/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.gatewayToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: `openclaw/${options.agentId}`,
          user: `sinaloa:${message.caseId || message.id}`,
          stream: false,
          messages: [{ role: 'user', content: workPrompt(message, history, { allowSinaloaMcpWrites: options.allowSinaloaMcpWrites, assetHandles: options.assetHandles }) }]
        })
      });
      if (!response.ok) throw new Error(`OpenClaw turn failed with HTTP ${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new Error('OpenClaw returned invalid JSON'); }
      const choices = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).choices : undefined;
      const first = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
      const result = first?.message as Record<string, unknown> | undefined;
      if (first?.finish_reason !== 'stop' || typeof result?.content !== 'string' || !result.content.trim()) {
        throw new Error('OpenClaw did not return a completed text reply');
      }
      if (controller.signal.aborted) throw new Error('OpenClaw turn was canceled or timed out');
      return parseAgentReply(result.content);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('OpenClaw turn was canceled or timed out');
      if (error instanceof Error && error.message.startsWith('OpenClaw ')) throw error;
      throw new Error('OpenClaw Gateway could not be reached');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
}
