import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Agent, HumanView } from '../types';
import { GrokBotPrompt } from './GrokBotSetup';

export function grokBotTestReply(view: Pick<HumanView, 'messages' | 'deliveryReceipts'>, agentId: string, text: string) {
  const request = view.messages.find(message => message.senderType === 'agent'
    && message.senderAgentId && message.senderAgentId !== agentId
    && message.recipientAgentId === agentId && message.text === text);
  if (!request || !view.deliveryReceipts.some(receipt => receipt.type === 'delivery' && receipt.state === 'processed'
    && receipt.messageId === request.id && receipt.recipientAgentId === agentId)) return undefined;
  return view.messages.find(message => message.senderType === 'agent' && message.senderAgentId === agentId
    && message.recipientAgentId === request.senderAgentId && message.caseId === request.caseId
    && message.causationId === request.id && message.id.startsWith('msg_work_reply_'));
}

export function GrokBotVerification({ inboxId, agent, background = false }: { inboxId: string; agent: Agent; background?: boolean }) {
  const [test, setTest] = useState('');
  const [replyAt, setReplyAt] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const canTest = agent.status === 'active' && !agent.paused && !agent.credentialRevoked
    && agent.permissions.includes('send_agent_messages') && agent.permissions.includes('receive_agent_messages');
  function prepare() {
    setTest(`Envoi Grok Bot ${background ? 'background' : 'reply'} test ${crypto.randomUUID()}. Please reply with a short confirmation through Envoi.`);
    setReplyAt('');
    setFeedback('');
  }

  async function verify() {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setFeedback('');
    try {
      const view = await api.humanView(inboxId, undefined, request.signal);
      const reply = grokBotTestReply(view, agent.id, test);
      if (reply) setReplyAt(reply.createdAt);
      else setFeedback('No matching reply and completion receipt yet. Check that the peer sent the exact test message, then check again.');
    } catch {
      if (!request.signal.aborted) setFeedback('Could not read the inbox. Try checking again.');
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  const peerPrompt = `Use your own Envoi connection to start a new case (envoi_start_case if available) addressed to ${agent.address}. Send the following exact message as the case's first message:\n\n${test}`;
  const botPrompt = `Verify your exact Envoi address is ${agent.address} with envoi_agent_info. Stop if it differs. Check for work with envoi_claim_work. Reply to the following exact test message using envoi_reply_to_work with its workId and leaseToken. If other work is claimed, handle it only under my existing instructions.\n\n${test}`;

  return <section aria-label={background ? 'Background delivery test' : 'Reply test'}>
    <h4>{background ? 'Verify background delivery' : 'Verify a real reply'}</h4>
    {background
      ? <p>After enabling a routine, close Grok Bot and leave it closed while another connected Envoi agent sends the test. For a scheduled-only test, leave the webhook unconfigured. Allow one routine interval before checking.</p>
      : <p>Use another connected Envoi agent to send a real test message to {agent.address}.</p>}
    {!canTest && <p>Testing requires an active agent with Receive and Send permissions.</p>}
    <button type="button" className="button secondary compact" disabled={!canTest || busy} onClick={prepare}>{test ? 'Prepare a new test' : background ? 'Grok Bot is closed — prepare test' : 'Prepare reply test'}</button>
    {test && <>
      <GrokBotPrompt label="Peer test instructions" copyLabel="Copy instructions for the sending agent" value={peerPrompt} />
      {!background && <GrokBotPrompt label="Grok Bot test instructions" copyLabel="Copy instructions for Grok Bot" value={botPrompt} />}
      <button type="button" className="button secondary compact" disabled={busy || !canTest} onClick={() => void verify()}>{busy ? 'Checking…' : 'Check for reply'}</button>
    </>}
    {replyAt && <p role="status">{background ? 'Reply and completion verified for the closed-chat test you ran.' : 'Reply and completion verified.'} <time dateTime={replyAt}>{new Date(replyAt).toLocaleString()}</time></p>}
    {feedback && <p role="status">{feedback}</p>}
  </section>;
}
