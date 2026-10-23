import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { claimProblem, type ClaimProblem } from './claim-state';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { remoteAuthApi } from './remote-auth-api';
import * as validate from './remote-auth.validator.mjs';
import { hasRemotePermissions, remoteGrantAllowed, remoteTargetMatches } from './remote-auth-grants';
import type { BootstrapIssued, BootstrapRequest, RemoteAuthApi } from './remote-auth-types';

interface BootstrapState { busy: boolean; attempted: boolean; hidden: boolean; issued: BootstrapIssued | null; problem: ClaimProblem | null }
/** One explicit issue attempt. A failed response is never automatically repeated. */
export class BootstrapController {
  private state: BootstrapState = { busy: false, attempted: false, hidden: false, issued: null, problem: null };
  private listeners = new Set<() => void>(); private generation = 0; private active: AbortController | null = null;
  constructor(private client: RemoteAuthApi, readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<BootstrapState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  dispose = () => { this.generation++; this.active?.abort(); this.active = null; this.state = { busy: false, attempted: false, hidden: false, issued: null, problem: null }; this.listeners.clear(); };
  hide = () => this.update({ issued: null, hidden: true });
  expire = () => { if (this.state.issued && Date.parse(this.state.issued.expiresAt) <= this.now()) this.hide(); };
  async issue(body: BootstrapRequest) {
    if (this.state.attempted || !validate.bootstrapCodeRequest(body) || !hasRemotePermissions(body.grantedPermissions)) return false;
    const grantedPermissions = [...body.grantedPermissions];
    const target = structuredClone(body.target);
    const generation = ++this.generation; const active = this.active = new AbortController();
    this.update({ busy: true, attempted: true });
    try {
      const raw = await this.client.bootstrap(structuredClone(body), active.signal);
      if (generation !== this.generation || active.signal.aborted) return false;
      if (!validate.bootstrapCodeIssued(raw)) throw { code: 'INVALID_OAUTH_RESPONSE' };
      const issued = raw as BootstrapIssued;
      if (!remoteTargetMatches(target, issued) || !remoteGrantAllowed(issued.effectivePermissions, grantedPermissions)) throw { code: 'INVALID_OAUTH_RESPONSE' };
      this.update({ busy: false, issued: Date.parse(issued.expiresAt) > this.now() && !this.state.hidden ? issued : null, hidden: this.state.hidden || Date.parse(issued.expiresAt) <= this.now() });
      return true;
    } catch (caught) {
      if (generation === this.generation && !active.signal.aborted) this.update({ busy: false, problem: claimProblem(caught, this.now()) });
      return false;
    }
  }
}
/** Mounted only by a future reviewed provider setup flow, never a provider catalog. */
export function ProviderBootstrapPanel({ humanId, request, client = remoteAuthApi, controller: supplied }: {
  humanId: string; request: BootstrapRequest; client?: RemoteAuthApi; controller?: BootstrapController;
}) {
  // A different target or grant must never inherit a displayed code or pending issuance.
  const key = JSON.stringify([humanId, request.clientId, request.target, request.grantedPermissions, request.policyProfile]);
  return <ProviderBootstrapSession key={key} request={request} client={client} controller={supplied} />;
}
function ProviderBootstrapSession({ request, client, controller: supplied }: { request: BootstrapRequest; client: RemoteAuthApi; controller?: BootstrapController }) {
  const controller = useMemo(() => supplied ?? new BootstrapController(client), [client, supplied]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const now = useClaimClock(controller.now);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { controller.expire(); }, [controller, now]);
  const issued = state.issued && Date.parse(state.issued.expiresAt) > now ? state.issued : null;
  return <section className="onboarding-panel" aria-labelledby="bootstrap-title">
    <h2 id="bootstrap-title">Provider connection code</h2>
    <p>This code is shown once. Paste it only into the provider's private credential field, never into a chat.</p>
    <ClaimProblemNotice problem={state.problem} now={now} />
    {!state.attempted && <button className="button primary" type="button" onClick={() => void controller.issue(request)}>Issue one-time code</button>}
    {state.busy && <p role="status">Preparing code…</p>}
    {issued && <><p>{issued.clientName} · {issued.provider}</p><code className="secret-block">{issued.bootstrapCode}</code>
      <p>Expires at <time dateTime={issued.expiresAt}>{new Date(issued.expiresAt).toLocaleString()}</time>.</p>
      <button className="button secondary" type="button" onClick={controller.hide}>Hide code permanently</button></>}
    {state.attempted && !state.busy && !issued && <p role="status">The code cannot be displayed again. An unused approval expires automatically. Review recent approvals before starting another provider connection.</p>}
  </section>;
}
