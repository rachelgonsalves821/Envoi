import { createHash } from 'node:crypto';

const invalid = () => { throw new Error('Invalid remote MCP authorization setup'); };
const knownScopes = ['envoi.agent', 'envoi.send', 'envoi.files', 'envoi.cases'];

function cleanOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || url.origin !== value) invalid();
  return value;
}

function validRedirect(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash || url.href !== value) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname) && !/^\[?[\da-f:.]+\]?$/i.test(url.hostname);
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
}

// Pure preparation for a trusted host. The caller keeps verifier, state, returned code,
// code-bearing URL and tokens in its private OAuth flow; none belongs in model context.
// This does not discover a server, offer a route, enroll a host or make it reachable.
export function planRemoteMcpAuthorization({ origin, protectedResource, authorizationServer,
  clientMetadata, redirectUri, codeVerifier, state, scopes = ['envoi.agent', 'envoi.send'] }) {
  const issuer = cleanOrigin(origin);
  const resource = `${issuer}/mcp`;
  if (protectedResource?.resource !== resource
    || JSON.stringify(protectedResource.authorization_servers) !== JSON.stringify([issuer])
    || !protectedResource.bearer_methods_supported?.includes('header')
    || authorizationServer?.issuer !== issuer
    || authorizationServer.authorization_endpoint !== `${issuer}/oauth/authorize`
    || authorizationServer.token_endpoint !== `${issuer}/oauth/token`
    || authorizationServer.revocation_endpoint !== `${issuer}/oauth/revoke`
    || !authorizationServer.code_challenge_methods_supported?.includes('S256')
    || !authorizationServer.grant_types_supported?.includes('authorization_code')
    || !authorizationServer.token_endpoint_auth_methods_supported?.includes('none')
    || authorizationServer.client_id_metadata_document_supported !== true) invalid();

  let clientUrl;
  try { clientUrl = new URL(clientMetadata?.client_id); } catch { invalid(); }
  if (clientUrl.protocol !== 'https:' || clientUrl.username || clientUrl.password
    || clientUrl.search || clientUrl.hash || clientUrl.pathname === '/'
    || clientUrl.href !== clientMetadata.client_id || clientUrl.origin === issuer
    || clientUrl.port || clientMetadata.client_id.length > 2048
    || (clientMetadata.token_endpoint_auth_method !== undefined
      && clientMetadata.token_endpoint_auth_method !== 'none')
    || !Array.isArray(clientMetadata.redirect_uris)
    || !clientMetadata.redirect_uris.includes(redirectUri)
    || !validRedirect(redirectUri)
    || (clientMetadata.grant_types !== undefined
      && (!Array.isArray(clientMetadata.grant_types)
        || !clientMetadata.grant_types.includes('authorization_code')
        || clientMetadata.grant_types.some(grant => !['authorization_code', 'refresh_token'].includes(grant))))
    || (clientMetadata.response_types !== undefined
      && JSON.stringify(clientMetadata.response_types) !== JSON.stringify(['code']))) invalid();

  if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
    || typeof state !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(state)
    || !Array.isArray(scopes) || scopes.length < 1 || new Set(scopes).size !== scopes.length
    || !scopes.includes('envoi.agent') || scopes.some(scope => !knownScopes.includes(scope))) invalid();
  const supported = new Set(protectedResource.scopes_supported);
  if (scopes.some(scope => !supported.has(scope)
    || !authorizationServer.scopes_supported?.includes(scope))) invalid();

  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const authorizationUrl = new URL(`${issuer}/oauth/authorize`);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientMetadata.client_id);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('resource', resource);
  authorizationUrl.searchParams.set('scope', knownScopes.filter(scope => scopes.includes(scope)).join(' '));
  authorizationUrl.searchParams.set('state', state);
  return { authorizationUrl: authorizationUrl.href, issuer, resource };
}
