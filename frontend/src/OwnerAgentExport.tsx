import { useState } from 'react';
import { request } from './api';
import type { Agent } from './types';
import { downloadOwnerEvidence, ownerAgentEvidence } from './agent-evidence';

export function OwnerAgentExport({ inboxId, agentId, allowed, notify }: { inboxId: string; agentId: string; allowed: boolean; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!allowed) return null;
  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const agents = await request<Agent[]>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents`);
      downloadOwnerEvidence(ownerAgentEvidence(agents, agentId), agentId);
      notify('Owner evidence download requested. Keep the JSON private and verify the saved file.');
    } catch {
      notify('Owner evidence could not be downloaded. Sign in as an owner and retry; no snapshot was saved by this action.');
    } finally { setBusy(false); }
  }
  return <button className="button secondary" disabled={busy} onClick={() => void download()}>{busy ? 'Preparing evidence' : 'Download owner evidence JSON'}</button>;
}
