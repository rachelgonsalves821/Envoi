import { PrivateHostTransport, closed, dateTime, matches, text, utf8Bytes, valid } from '../connector/private-host-http';

export type NativeAction = 'reply' | 'request_owner' | 'defer';
export interface NativePacket {
  workRef: string; caseRef: string; runId: string; kind: 'agent_message' | 'human_instruction'; untrusted: true;
  leaseExpiresAt: string; renewalsLeft: number;
  snapshot: {
    objective: string; status: string; participants: { role: 'self' | 'counterparty'; displayName: string }[];
    recentEvents: { at: string; from: 'self' | 'counterparty' | 'owner'; summary: string; truncated: boolean }[];
    assets: { assetRef: string; name: string; state: 'clean' | 'pending_scan' | 'quarantined'; bytesAvailable: false }[];
    pendingProposal: Record<string, unknown> | null;
  };
  allowedActions: NativeAction[];
}
export interface NativeClaim { state: 'work' | 'idle' | 'budget_reached'; packet: NativePacket | null; retryAfterSeconds: number | null; replayed: boolean }
export interface NativeActInput { runId: string; workRef: string; idempotencyKey: string; action: NativeAction; text?: string }
export interface NativeActResult { state: 'sent' | 'owner_approval_pending' | 'deferred'; runId: string; workRef: string; receiptRef?: string; requestRef?: string; settled: boolean; replayed: boolean }
const runId = /^[A-Za-z0-9_-]{1,80}$/;
const workRef = /^w_[A-Za-z0-9]{12,}$/;
const actions = ['reply', 'request_owner', 'defer'];
function run(value: unknown) { if (!matches(value, runId)) throw new TypeError('A persisted runId is required'); }
function work(value: unknown) { if (!matches(value, workRef)) throw new TypeError('A claimed workRef is required'); }
function packet(value: unknown): NativePacket {
  closed(value, ['workRef', 'caseRef', 'runId', 'kind', 'untrusted', 'leaseExpiresAt', 'renewalsLeft', 'snapshot', 'allowedActions']);
  valid(matches(value.workRef, workRef) && matches(value.caseRef, /^c_[A-Za-z0-9]{12,}$/) && matches(value.runId, runId));
  valid(['agent_message', 'human_instruction'].includes(value.kind as string) && value.untrusted === true && dateTime(value.leaseExpiresAt) && [0, 1].includes(value.renewalsLeft as number));
  valid(Array.isArray(value.allowedActions) && new Set(value.allowedActions).size === value.allowedActions.length && value.allowedActions.every(action => actions.includes(action)));
  const snapshot = value.snapshot;
  closed(snapshot, ['objective', 'status', 'participants', 'recentEvents', 'assets', 'pendingProposal']);
  valid(text(snapshot.objective, 500) && text(snapshot.status, 100));
  valid(Array.isArray(snapshot.participants) && snapshot.participants.length <= 4);
  for (const participant of snapshot.participants) {
    closed(participant, ['role', 'displayName']);
    valid(['self', 'counterparty'].includes(participant.role as string) && text(participant.displayName, 80));
  }
  valid(Array.isArray(snapshot.recentEvents) && snapshot.recentEvents.length <= 10);
  for (const event of snapshot.recentEvents) {
    closed(event, ['at', 'from', 'summary', 'truncated']);
    valid(dateTime(event.at) && ['self', 'counterparty', 'owner'].includes(event.from as string) && text(event.summary, 2048) && utf8Bytes(event.summary) <= 2048 && typeof event.truncated === 'boolean');
  }
  valid(Array.isArray(snapshot.assets) && snapshot.assets.length <= 10);
  for (const asset of snapshot.assets) {
    closed(asset, ['assetRef', 'name', 'state', 'bytesAvailable']);
    valid(matches(asset.assetRef, /^a_[A-Za-z0-9]{6,}$/) && text(asset.name, 80) && ['clean', 'pending_scan', 'quarantined'].includes(asset.state as string) && asset.bytesAvailable === false);
  }
  valid(snapshot.pendingProposal === null || (typeof snapshot.pendingProposal === 'object' && !Array.isArray(snapshot.pendingProposal)));
  return value as unknown as NativePacket;
}

/** Browser/approved host adapter only. HttpOnly gateway cookie and CSRF stay outside model context. */
export class NativeGatewayClient {
  #transport: PrivateHostTransport;
  constructor(options: { origin: string; csrf: () => Promise<string>; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#transport = new PrivateHostTransport({ ...options, credentials: 'same-origin', headers: async () => {
      const csrf = await options.csrf();
      if (!csrf || /[\r\n]/.test(csrf)) throw new TypeError('Private CSRF required');
      return { 'x-envoi-gateway-csrf': csrf };
    } });
  }
  get lifecycle() { return this.#transport.lifecycle; }
  ownerResumed() { this.#transport.ownerResumed(); }
  /** Persist runId before calling. A lost response retries this same run; never creates a new run implicitly. */
  async claim(input: { runId: string }): Promise<NativeClaim> {
    closed(input, ['runId']); run(input.runId);
    const result = await this.#transport.post('/api/agent-gateway/work/claim', input);
    closed(result, ['state', 'packet', 'retryAfterSeconds', 'replayed']);
    valid(['work', 'idle', 'budget_reached'].includes(result.state as string) && typeof result.replayed === 'boolean');
    valid(result.retryAfterSeconds === null || (Number.isInteger(result.retryAfterSeconds) && Number(result.retryAfterSeconds) >= 1));
    if (result.packet !== null) {
      const claimed = packet(result.packet);
      valid(result.state === 'work' && claimed.runId === input.runId);
    } else valid(result.state !== 'work');
    return result as unknown as NativeClaim;
  }
  /** Persist the entire input before sending. After any uncertain result, reuse it byte-for-byte. */
  async act(input: NativeActInput): Promise<NativeActResult> {
    closed(input, ['runId', 'workRef', 'idempotencyKey', 'action'], ['text']);
    run(input.runId); work(input.workRef);
    if (!text(input.idempotencyKey, 80) || !input.idempotencyKey.length || !actions.includes(input.action)) throw new TypeError('Invalid native action');
    if (input.action === 'reply' && !Object.hasOwn(input, 'text')) throw new TypeError('Reply text is required');
    if (Object.hasOwn(input, 'text') && (!text(input.text, 4096) || !input.text.length || utf8Bytes(input.text) > 4096)) throw new TypeError('Text must fit 4096 UTF-8 bytes');
    const result = await this.#transport.post('/api/agent-gateway/work/act', input);
    closed(result, ['state', 'runId', 'workRef', 'settled', 'replayed'], ['receiptRef', 'requestRef']);
    valid(['sent', 'owner_approval_pending', 'deferred'].includes(result.state as string) && result.runId === input.runId && result.workRef === input.workRef && typeof result.settled === 'boolean' && typeof result.replayed === 'boolean');
    if (result.receiptRef !== undefined) valid(matches(result.receiptRef, /^r_[A-Za-z0-9]{12,}$/));
    if (result.requestRef !== undefined) valid(matches(result.requestRef, /^q_[A-Za-z0-9]{12,}$/));
    if (result.state === 'sent') valid(result.receiptRef !== undefined && result.settled === true);
    if (result.state === 'owner_approval_pending') valid(result.requestRef !== undefined);
    return result as unknown as NativeActResult;
  }
  async renew(input: { runId: string; workRef: string }): Promise<{ workRef: string; leaseExpiresAt: string; renewalsLeft: number }> {
    closed(input, ['runId', 'workRef']); run(input.runId); work(input.workRef);
    const result = await this.#transport.post('/api/agent-gateway/work/renew', input);
    closed(result, ['workRef', 'leaseExpiresAt', 'renewalsLeft']);
    valid(result.workRef === input.workRef && dateTime(result.leaseExpiresAt) && result.renewalsLeft === 0);
    return result as Awaited<ReturnType<NativeGatewayClient['renew']>>;
  }
}
