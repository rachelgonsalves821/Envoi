// case-session v1 §6: /mcp for a request authenticated by a case session token. The server has
// already run the §6.2 step 1–5 checks; this answers the JSON-RPC part. Case tools run in-process
// against the session's scope (§6.3) and never through the REST loopback that legacy tools use.
import Ajv2020 from 'ajv/dist/2020.js';
import { mcpReply, readMcpRequest } from './agent-mcp.js';

const { sendJson, rpcError, rpcResult } = mcpReply;
const codedRpcError = (id, message, code) => ({ jsonrpc: '2.0', id, error: { code: -32602, message, data: { code } } });

// `tools` maps each implemented case tool's name to { description, inputSchema, run(args, scope) }.
// `scope` names the session's work and case for the server only; it carries no token, hash, fence,
// family or installation, and no tool result may echo an id from it (§4).
// Every input schema must refuse extra properties, so a scope field fails as TOOL_ARGUMENTS_INVALID.
export function createCaseSessionMcp(tools = new Map()) {
  // case-tools v1's input schemas name properties in conditional 'required' lists without
  // redeclaring them there, which strictRequired reports; every other strict check stays on.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const validators = new Map();
  for (const [name, tool] of tools) {
    if (tool.inputSchema?.additionalProperties !== false) throw new Error(`Case tool ${name} must refuse additional properties`);
    validators.set(name, ajv.compile(tool.inputSchema));
  }
  return {
    implemented: new Set(tools.keys()),
    // `effectiveTools` is the §6.4 effective set for this request, in x-case-tools order.
    async handle(req, res, { effectiveTools, scope }) {
      const read = await readMcpRequest(req, res);
      if (!read?.request) return;
      const { request } = read;
      const id = request.id;
      if (request.method === 'ping') return sendJson(res, 200, rpcResult(id, {}));
      if (request.method === 'tools/list') {
        if (request.params?.cursor) return sendJson(res, 200, rpcError(id, -32602, 'Tool cursor is invalid'));
        return sendJson(res, 200, rpcResult(id, {
          tools: effectiveTools.map(name => ({ name, description: tools.get(name).description, inputSchema: tools.get(name).inputSchema }))
        }));
      }
      if (request.method !== 'tools/call') return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
      const name = request.params?.name;
      if (typeof name !== 'string' || !effectiveTools.includes(name)) return sendJson(res, 200, codedRpcError(id, 'Tool not available in this case session', 'TOOL_NOT_IN_SESSION'));
      const args = request.params?.arguments ?? {};
      if (!validators.get(name)(args)) return sendJson(res, 200, codedRpcError(id, 'Invalid tool arguments', 'TOOL_ARGUMENTS_INVALID'));
      try { return sendJson(res, 200, rpcResult(id, await tools.get(name).run(args, scope))); }
      catch (error) {
        if (error.invalidToolArguments) return sendJson(res, 200, codedRpcError(id, 'Invalid tool arguments', 'TOOL_ARGUMENTS_INVALID'));
        if (error.toolNotInSession) return sendJson(res, 200, codedRpcError(id, 'Tool not available in this case session', 'TOOL_NOT_IN_SESSION'));
        throw error;
      }
    }
  };
}
