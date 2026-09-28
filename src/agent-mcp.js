import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

// The handshake-era Streamable HTTP protocol permits stateless JSON responses.
// No MCP session is issued; the active agent credential is checked on every call.
const supportedVersions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const currentVersion = '2025-11-25';
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const idempotencyKey = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f]+$' };
const address = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$' };
const text = { type: 'string', minLength: 1, maxLength: 60000 };
const empty = { type: 'object', additionalProperties: false };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const sendFields = {
  recipientAddress: address,
  text,
  idempotencyKey,
  intent: { type: 'string', enum: ['request', 'offer', 'counteroffer', 'accept', 'reject', 'clarify', 'commit', 'cancel', 'status', 'receipt', 'message'] }
};
const structuredValue = { type: 'object', minProperties: 1, maxProperties: 32 };

export const agentMcpTools = Object.freeze([
  { name: 'sinaloa_agent_info', description: 'Return the authenticated agent address and permissions. The agent and inbox are selected from the bearer credential.', inputSchema: empty, permission: null },
  { name: 'sinaloa_list_cases', description: 'List cases in this agent’s own inbox.', inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', minLength: 1, maxLength: 256 } }), permission: 'read' },
  { name: 'sinaloa_read_case', description: 'Read one case in this agent’s own inbox.', inputSchema: schema({ caseId: identifier }, ['caseId']), permission: 'read' },
  { name: 'sinaloa_list_messages', description: 'List messages in this agent’s own inbox, optionally for a case.', inputSchema: schema({ caseId: identifier, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', minLength: 1, maxLength: 256 } }), permission: 'read' },
  { name: 'sinaloa_start_case', description: 'Start a new case and send its first native agent message to an exact known Sinaloa address. Retries with the same idempotency key reuse the same case.', inputSchema: schema(sendFields, ['recipientAddress', 'text', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'sinaloa_send_message', description: 'Send a native agent message in an existing case to an exact known Sinaloa address.', inputSchema: schema({ ...sendFields, caseId: identifier }, ['recipientAddress', 'text', 'caseId', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'sinaloa_send_proposal', description: 'Send a structured, agent-authored proposal in an existing shared case. This is a native collaboration message, not a server-attested approval.', inputSchema: schema({ recipientAddress: address, caseId: identifier, text, proposal: structuredValue, idempotencyKey }, ['recipientAddress', 'caseId', 'text', 'proposal', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'sinaloa_send_decision', description: 'Send a structured, agent-authored accept, reject, counteroffer, or clarification message in an existing shared case. This does not execute an external action.', inputSchema: schema({ recipientAddress: address, caseId: identifier, text, decision: { type: 'string', enum: ['accept', 'reject', 'counteroffer', 'clarify'] }, proposalMessageId: identifier, details: structuredValue, idempotencyKey }, ['recipientAddress', 'caseId', 'text', 'decision', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'sinaloa_list_assets', description: 'List asset metadata in this agent’s own inbox, including scan state. No binary content is returned.', inputSchema: empty, permission: 'read' },
  { name: 'sinaloa_begin_asset_upload', description: 'Reserve a quarantined asset and return a short-lived signed binary PUT URL. Upload bytes directly to that URL, then complete the asset. Reuse the idempotency key for a retry.', inputSchema: schema({ filename: { type: 'string', minLength: 1, maxLength: 255 }, mimeType: { type: 'string', minLength: 1, maxLength: 128 }, size: { type: 'integer', minimum: 1, maximum: 26214400 }, checksumSha256: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' }, caseId: identifier, idempotencyKey }, ['filename', 'mimeType', 'size', 'checksumSha256', 'idempotencyKey']), permission: 'create_assets' },
  { name: 'sinaloa_complete_asset_upload', description: 'Verify an uploaded asset and run the configured malware scan. Only a clean result can be downloaded.', inputSchema: schema({ assetId: identifier }, ['assetId']), permission: 'create_assets' },
  { name: 'sinaloa_asset_download', description: 'Return a short-lived signed download URL for a clean asset in this agent’s own inbox.', inputSchema: schema({ assetId: identifier }, ['assetId']), permission: 'read' },
  { name: 'sinaloa_claim_work', description: 'Claim one incoming message under a fenced lease. An empty work field means no work is available.', inputSchema: empty, permission: 'receive_agent_messages' },
  { name: 'sinaloa_renew_work', description: 'Extend the current work lease; requires its opaque fence token.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 } }, ['workId', 'leaseToken']), permission: 'receive_agent_messages' },
  { name: 'sinaloa_acknowledge_work', description: 'Record admission of claimed work using a fenced lease and idempotency key.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyKey }, ['workId', 'leaseToken', 'idempotencyKey']), permission: 'receive_agent_messages' },
  { name: 'sinaloa_complete_work', description: 'Record successful processing of claimed work using a fenced lease and idempotency key.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyKey }, ['workId', 'leaseToken', 'idempotencyKey']), permission: 'receive_agent_messages' },
  { name: 'sinaloa_fail_work', description: 'Record failed processing of claimed work; retryable failures use bounded server backoff.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, retryable: { type: 'boolean' }, reasonCode: { type: 'string', maxLength: 120 } }, ['workId', 'leaseToken', 'retryable']), permission: 'receive_agent_messages' }
]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map(agentMcpTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
const publicTool = ({ name, description, inputSchema }) => ({ name, description, inputSchema });
const hasPermission = (identity, permission) => permission === null || (permission === 'read'
  ? identity.agent.permissions?.some(value => value === 'send_agent_messages' || value === 'receive_agent_messages')
  : identity.agent.permissions?.includes(permission));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
const query = args => {
  const params = new URLSearchParams();
  if (args.caseId) params.set('caseId', args.caseId);
  if (args.limit) params.set('limit', String(args.limit));
  if (args.before) params.set('before', args.before);
  return params.size ? `?${params}` : '';
};

async function invokeTool(name, args, identity, callRest) {
  const base = `/api/inboxes/${identity.inboxId}`;
  if (name === 'sinaloa_agent_info') return { agentId: identity.agent.id, inboxId: identity.inboxId, address: identity.agent.address, permissions: identity.agent.permissions };
  if (name === 'sinaloa_list_cases') return callRest('GET', `${base}/cases${query(args)}`);
  if (name === 'sinaloa_read_case') return callRest('GET', `${base}/cases/${args.caseId}`);
  if (name === 'sinaloa_list_messages') return callRest('GET', `${base}/messages${query(args)}`);
  if (name === 'sinaloa_list_assets') return callRest('GET', `${base}/assets`);
  if (name === 'sinaloa_begin_asset_upload') {
    const { idempotencyKey: key, ...metadata } = args;
    return callRest('POST', `${base}/asset-uploads`, metadata, key);
  }
  if (name === 'sinaloa_complete_asset_upload') return callRest('POST', `${base}/assets/${args.assetId}/complete`, {});
  if (name === 'sinaloa_asset_download') return callRest('GET', `${base}/assets/${args.assetId}/download`);
  if (['sinaloa_start_case', 'sinaloa_send_message', 'sinaloa_send_proposal', 'sinaloa_send_decision'].includes(name)) {
    const caseId = name === 'sinaloa_start_case'
      ? `case_${crypto.createHash('sha256').update(`${identity.agent.id}:${args.idempotencyKey}`).digest('hex').slice(0, 32)}`
      : args.caseId;
    const isProposal = name === 'sinaloa_send_proposal';
    const isDecision = name === 'sinaloa_send_decision';
    const { status, payload } = await callRest('POST', `${base}/messages`, {
      senderAgentId: identity.agent.id,
      recipientEmail: args.recipientAddress,
      text: args.text,
      intent: isProposal ? 'offer' : isDecision ? args.decision : args.intent || 'message',
      caseId,
      ...(isProposal ? { type: 'proposal', payload: { proposal: args.proposal } } : {}),
      ...(isDecision ? { type: 'decision', payload: { decision: { kind: args.decision, proposalMessageId: args.proposalMessageId || null, details: args.details || null } } } : {})
    }, args.idempotencyKey);
    return { status, payload: { ...payload, caseId: payload?.caseId || caseId } };
  }
  if (name === 'sinaloa_claim_work') return callRest('POST', '/api/agent/work/claim', {});
  const action = {
    sinaloa_renew_work: 'renew',
    sinaloa_acknowledge_work: 'acknowledge',
    sinaloa_complete_work: 'complete',
    sinaloa_fail_work: 'fail'
  }[name];
  return callRest('POST', `/api/agent/work/${args.workId}/${action}`, {
    leaseToken: args.leaseToken,
    ...(action === 'fail' ? { retryable: args.retryable, reasonCode: args.reasonCode } : {})
  }, args.idempotencyKey);
}

export async function handleAgentMcp(req, res, { identity, callRest, maxRequestBytes = 64 * 1024 }) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    return res.end();
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    return res.end();
  }
  const accept = String(req.headers.accept || '').toLowerCase();
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return sendJson(res, 406, rpcError(null, -32600, 'Accept must include application/json and text/event-stream'));
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, rpcError(null, -32600, 'Content-Type must be application/json'));
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) return sendJson(res, 413, rpcError(null, -32600, 'MCP request is too large'));
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return sendJson(res, 400, rpcError(null, -32700, 'Invalid JSON')); }
  if (!request || Array.isArray(request) || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return sendJson(res, 400, rpcError(null, -32600, 'A single JSON-RPC request or notification is required'));
  }
  const id = request.id;
  if (id !== undefined && !(typeof id === 'string' || typeof id === 'number') || id === null) return sendJson(res, 400, rpcError(null, -32600, 'Invalid JSON-RPC id'));
  if (request.method === 'notifications/initialized' && id === undefined) {
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  if (id === undefined) return sendJson(res, 400, rpcError(null, -32600, 'Unsupported notification'));
  if (request.method === 'initialize') {
    if (typeof request.params?.protocolVersion !== 'string' || !request.params?.clientInfo || !request.params?.capabilities) {
      return sendJson(res, 200, rpcError(id, -32602, 'Invalid initialize parameters'));
    }
    const protocolVersion = supportedVersions.has(request.params.protocolVersion) ? request.params.protocolVersion : currentVersion;
    return sendJson(res, 200, rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sinaloa', version: '0.1.0' } }));
  }
  const version = req.headers['mcp-protocol-version'];
  if (version && !supportedVersions.has(String(version))) return sendJson(res, 400, rpcError(id, -32600, 'Unsupported MCP protocol version'));
  if (request.method === 'ping') return sendJson(res, 200, rpcResult(id, {}));
  if (request.method === 'tools/list') {
    if (request.params?.cursor) return sendJson(res, 200, rpcError(id, -32602, 'Tool cursor is invalid'));
    return sendJson(res, 200, rpcResult(id, { tools: agentMcpTools.filter(tool => hasPermission(identity, tool.permission)).map(publicTool) }));
  }
  if (request.method !== 'tools/call') return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
  const name = request.params?.name;
  const tool = agentMcpTools.find(candidate => candidate.name === name);
  if (!tool || !hasPermission(identity, tool.permission)) return sendJson(res, 200, rpcError(id, -32602, 'Tool not available to this agent'));
  const args = request.params?.arguments ?? {};
  if (!validators.get(name)(args)) return sendJson(res, 200, rpcError(id, -32602, 'Invalid tool arguments'));
  try {
    const response = await invokeTool(name, args, identity, callRest);
    if (response?.status && response.status >= 400) return sendJson(res, 200, rpcResult(id, toolResult({ status: response.status, ...response.payload }, true)));
    return sendJson(res, 200, rpcResult(id, toolResult(response)));
  } catch {
    return sendJson(res, 200, rpcResult(id, toolResult({ error: 'Tool temporarily unavailable' }, true)));
  }
}
