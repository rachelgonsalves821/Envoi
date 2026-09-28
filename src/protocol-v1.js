import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const PROTOCOL_VERSION = '1.0';
export const PROTOCOL_INTENTS = Object.freeze(['request', 'offer', 'counteroffer', 'accept', 'reject', 'clarify', 'commit', 'cancel', 'status', 'receipt', 'message']);

const schema = JSON.parse(readFileSync(new URL('../protocol/sinaloa-protocol-v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateMessage = ajv.compile(schema);

const protocolError = details => Object.assign(new Error('Message does not satisfy Sinaloa Protocol v1'), { statusCode: 422, details });

export function assertValidProtocolMessage(value) {
  if (!validateMessage(value)) throw protocolError(validateMessage.errors);
  return value;
}

export function createProtocolMessage({
  messageId,
  conversationId,
  taskId = null,
  correlationId = null,
  causationId = null,
  from,
  to,
  intent = 'message',
  text,
  content,
  proposal = null,
  authority = { scope: 'message.send', humanApproval: 'notRequired', policyEvaluationId: null },
  artifactRefs = [],
  requiresAck = true,
  traceparent = null,
  signature = null,
  createdAt
}) {
  const normalizedIntent = PROTOCOL_INTENTS.includes(intent) ? intent : 'message';
  const value = {
    schemaVersion: PROTOCOL_VERSION,
    messageId,
    conversationId,
    taskId,
    correlationId,
    causationId,
    from,
    to,
    intent: normalizedIntent,
    content: Array.isArray(content) && content.length ? content : [{ type: 'text', text: String(text || '') }],
    proposal,
    authority: {
      scope: authority?.scope || 'message.send',
      humanApproval: authority?.humanApproval || 'notRequired',
      policyEvaluationId: authority?.policyEvaluationId || null
    },
    artifactRefs: [...new Set(artifactRefs || [])],
    requiresAck: Boolean(requiresAck),
    traceparent,
    signature,
    createdAt
  };
  return assertValidProtocolMessage(value);
}
