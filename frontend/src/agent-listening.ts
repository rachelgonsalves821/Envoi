import { dotsMonitoringPrompt, dotsRestorePrompt, RUNTIME_OPTIONS, runtimeLabel } from './quick-connect';
import type { Agent, AgentBackgroundReceiving } from './types';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import type { Installation } from './onboarding/types';

type BannerAction = 'restore_prompt' | 'monitoring_prompt' | 'reconnect' | 'restart_connector' | 'none';
interface BannerRow {
  state: string;
  endedReason: string | null;
  title: string;
  body: string;
  docs: string;
  action: BannerAction;
  minStateSeconds?: number;
  connectionStates?: string[];
}

// agent-listening-status v1 x-owner-banner. Consuming tests compare the canonical fixture table.
const rows: BannerRow[] = [
  { state: "off", endedReason: "credential_ended", title: "{name} isn't listening", body: "Background receiving ended when this agent reconnected. {count} waiting.", docs: "/docs/fix/#listening-ended-after-reconnect", action: "restore_prompt" },
  { state: "off", endedReason: null, title: "{name} isn't listening", body: "Background receiving was never turned on for this agent. {count} waiting.", docs: "/docs/fix/#agent-not-listening", action: "monitoring_prompt" },
  { state: "off", endedReason: "*", title: "{name} isn't listening", body: "Background receiving stopped. {count} waiting.", docs: "/docs/fix/#agent-not-listening", action: "monitoring_prompt" },
  { state: "starting", endedReason: null, minStateSeconds: 600, title: "{name} is still setting up", body: "Background receiving hasn't finished starting. {count} waiting.", docs: "/docs/fix/#agent-not-listening", action: "monitoring_prompt" },
  { state: "failing", endedReason: null, title: "{name} isn't getting alerts", body: "Envoi can't reach this agent's host. {count} waiting.", docs: "/docs/fix/#background-receiving-failing", action: "restore_prompt" },
  { state: "unavailable", endedReason: null, title: "{name} only works when you ask", body: "Background receiving isn't available on this Envoi deployment. {count} waiting.", docs: "/docs/fix/#background-receiving-unavailable", action: "none" },
  { state: "connector", endedReason: null, connectionStates: ["needs_reconnect"], title: "{name} needs to reconnect", body: "Its connection to Envoi ended, so messages wait. {count} waiting.", docs: "/docs/fix/#agent-not-listening", action: "reconnect" },
  { state: "connector", endedReason: null, connectionStates: ["never_seen","not_seen_recently"], title: "{name} isn't running", body: "Its connector is not running, so messages wait. {count} waiting.", docs: "/docs/fix/#agent-not-listening", action: "restart_connector" },
];

export function listeningBadge(status?: AgentBackgroundReceiving): string | null {
  switch (status?.state) {
    case 'on': return 'Background receiving: On';
    case 'starting': return 'Background receiving: Starting';
    case 'failing': return 'Background receiving: Failing';
    case 'off': return 'Background receiving: Off';
    case 'unavailable': return 'On demand only';
    default: return null;
  }
}

export function listeningBanner(agent: Pick<Agent, 'name' | 'backgroundReceiving' | 'connection'>, asOf = agent.connection?.asOf) {
  const status = agent.backgroundReceiving;
  if (!status || !status.waiting || !(status.waiting.count > 0)) return null;
  const { state, since, endedReason, waiting } = status;
  const age = since && asOf ? (Date.parse(asOf) - Date.parse(since)) / 1000 : 0;
  const row = rows.find(item => item.state === state
    && (item.endedReason === '*' ? typeof endedReason === 'string' : item.endedReason === endedReason)
    && (!item.connectionStates || item.connectionStates.includes(agent.connection?.state ?? ''))
    && (item.minStateSeconds === undefined || age > item.minStateSeconds));
  if (!row) return null;
  const count = waiting.more ? '50+ messages are' : waiting.count === 1 ? '1 message is' : `${waiting.count} messages are`;
  return { title: row.title.replace('{name}', () => agent.name), body: row.body.replace('{count}', count), docs: row.docs, action: row.action };
}

export function listeningConnectorRuntime(installations: readonly Installation[]): ConnectorRuntime | undefined {
  const latest = installations.find(item => item.status === 'active') ?? installations[0];
  return RUNTIME_OPTIONS.find(option => option.id === latest?.runtime.type)?.id;
}

const restartConnector = "Restart the Envoi connector for {name} ({address}) on the computer where {platform} runs, then check that it connects. If it still does not connect, follow {docs}.";

export function listeningFixInstructions(banner: NonNullable<ReturnType<typeof listeningBanner>>, agent: Pick<Agent, 'name' | 'address'>, origin: string, runtime?: ConnectorRuntime) {
  if (banner.action === 'restore_prompt') return dotsRestorePrompt(origin, agent.address, banner.docs);
  if (banner.action === 'monitoring_prompt') return dotsMonitoringPrompt(origin, agent.address);
  if (banner.action === 'restart_connector') {
    const docs = new URL(banner.docs, origin).href;
    if (!runtime) return `Restart the Envoi connector for ${agent.name} (${agent.address}) on the computer where your agent runs, then check that it connects. If it still does not connect, follow ${docs}.`;
    const values = { name: agent.name, address: agent.address, platform: runtimeLabel(runtime), docs };
    return restartConnector.replace(/\{(name|address|platform|docs)\}/g, (_match, key: keyof typeof values) => values[key]);
  }
  return null;
}
