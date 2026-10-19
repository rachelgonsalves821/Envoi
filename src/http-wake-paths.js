import path from 'node:path';

// http-wake v1 §11: wake documents. Subscriptions are stored per agent, so a trigger, a list or a
// create reads only that agent's records. Two small indexes keep the dispatcher and maintenance
// from listing every record: one entry per subscription (with its status), and one per live
// notification. Every notification record, live or finished, stays in the queue folder.
export const wakeRoot = 'http-wake';
export const wakeSubscriptionDir = agentId => path.join(wakeRoot, 'agents', agentId, 'wake-subscriptions');
export const wakeSubscriptionPath = (agentId, id) => path.join(wakeSubscriptionDir(agentId), `${id}.json`);
export const wakeSubscriptionIndexDir = path.join(wakeRoot, 'subscription-index');
export const wakeSubscriptionIndexPath = id => path.join(wakeSubscriptionIndexDir, `${id}.json`);
export const wakeQueueDir = path.join(wakeRoot, 'queue');
export const wakeEventPath = id => path.join(wakeQueueDir, `${id}.json`);
export const wakeLiveDir = path.join(wakeRoot, 'live');
export const wakeLivePath = id => path.join(wakeLiveDir, `${id}.json`);
