/** Keep a case-scoped Envoi MCP token on the same origin that issued it. */
export function validateEnvoiMcpDestination(apiUrl: string, mcpUrl: string, requirePublic = true): void {
  let api: URL;
  let mcp: URL;
  try {
    api = new URL(apiUrl);
    mcp = new URL(mcpUrl);
  } catch { throw new TypeError('Envoi MCP destination is invalid'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(mcp.hostname);
  if (api.username || api.password || api.search || api.hash
    || mcp.username || mcp.password || mcp.search || mcp.hash
    || mcp.pathname !== '/mcp' || mcp.origin !== api.origin
    || (requirePublic && (mcp.protocol !== 'https:' || loopback))
    || (!requirePublic && !(mcp.protocol === 'https:' || (mcp.protocol === 'http:' && loopback)))) {
    throw new TypeError('Envoi MCP destination must be the configured Envoi origin /mcp');
  }
}
