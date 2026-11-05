// Synthetic browser fixture only. Run from the repo root with:
// node frontend/acceptance/inbox-startup-fixture.mjs
// No application server, real identity, credential, storage or external runtime.
import { createServer } from 'vite';
import { connectionRoutes, deliveryModes } from '../src/onboarding/route-enums.mjs';
let views;
let signedOut = false;
const controls = new Map();
const requests = [];
const fixture = {
  name: 'synthetic-inbox-startup-fixture',
  transformIndexHtml(html) {
    return html.replace('</body>', `<nav aria-label="Synthetic fixture routes"><a href="/authorize-agent?request=synthetic-one">Fixture authorize one</a> <a href="/authorize-agent?request=synthetic-two">Fixture authorize two</a> <a href="/api/auth/workos/sign-in?returnTo=%2Fapp">Fixture sign-in</a></nav><meta name="synthetic-document" content="${Date.now()}"></body>`);
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (url.pathname === '/__fixture/control') {
        controls.set(url.searchParams.get('inbox'), { delay: Number(url.searchParams.get('delay') || 0), mode: url.searchParams.get('mode') || 'ready' });
        return send({ synthetic: true });
      }
      if (url.pathname === '/__fixture/requests') return send(requests);
      if (url.pathname === '/fixture-signed-out') { res.setHeader('content-type', 'text/html'); return res.end('<h1>Synthetic sign-out confirmed</h1>'); }
      if (!url.pathname.startsWith('/api/')) return next();
      const requestRecord = { method: req.method, path: url.pathname, at: Date.now(), completedAt: null }; requests.push(requestRecord); res.on('finish', () => { requestRecord.completedAt = Date.now(); });
      if (url.pathname === '/api/auth/workos/sign-in') { res.setHeader('content-type', 'text/html'); return res.end('<h1>Synthetic identity-provider sign-in</h1>'); }
      if (url.pathname.startsWith('/api/oauth/authorization-requests/')) return send({ message: 'Synthetic authorization request ' + url.pathname.split('/').pop() + ' unavailable' }, 404);
      if (url.pathname === '/api/auth/config') return send({ provider: 'local', hosted: false });
      if (url.pathname === '/api/auth/me') return signedOut ? send({ message: 'Signed out' }, 401) : send({ id: 'human_preview', displayName: 'Synthetic owner', auth: { provider: 'local', assurance: 'mfa' } });
      if (url.pathname === '/api/auth/logout') { signedOut = true; return send({ revoked: true, logoutUrl: '/fixture-signed-out' }); }
      if (url.pathname === '/api/organizations') { await new Promise(resolve => setTimeout(resolve, controls.get('directory')?.delay ?? 2500)); return send([{ id: 'org_preview', name: 'Synthetic organization' }]); }
      if (url.pathname === '/api/organizations/org_preview/workspaces') return send(Object.values(views).map(view => view.inbox));
      if (url.pathname === '/api/onboarding/routes') return send({ asOf: new Date().toISOString(), contract: { id: 'agent-registration', version: 1 }, registrationEnabled: true, installationsEnabled: true, routes: connectionRoutes.map(connectionRoute => ({ connectionRoute, available: connectionRoute === 'local_helper' })), deliveryModes: deliveryModes.map(deliveryMode => ({ deliveryMode, available: deliveryMode === 'envoi_link' })) });
      const match = /^\/api\/inboxes\/([^/]+)\/human-view$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const control = controls.get(id) || {};
        await new Promise(resolve => setTimeout(resolve, control.delay ?? 100));
        if (control.mode === 'denied') return send({ message: 'Synthetic inbox denied' }, 403);
        if (control.mode === 'failed') return send({ message: 'Synthetic transport failure' }, 503);
        if (!views[id]) return send({ message: 'Unknown synthetic inbox' }, 404);
        return send(control.mode === 'wrong' ? views.inbox_root : views[id]);
      }
      if (url.pathname.endsWith('/inbox-preferences')) return send({ inboxPreference: { read: true, archived: false, folderId: null } });
      if (url.pathname.endsWith('/events')) { res.setHeader('content-type', 'text/event-stream'); res.write(': synthetic\n\n'); return; }
      return send({ message: 'Unsupported synthetic endpoint' }, 404);
    });
  }
};
const server = await createServer({ plugins: [fixture], server: { host: '127.0.0.1', port: 5187, strictPort: true } });
const { previewView } = await server.ssrLoadModule('/src/App.tsx');
const clone = value => JSON.parse(JSON.stringify(value));
views = {};
for (const [id, name, kind] of [['inbox_root', 'Synthetic workspace', 'workspace'], ['inbox_milo', 'Milo inbox', 'agent'], ['inbox_iris', 'Iris inbox', 'agent']]) {
  const view = clone(previewView);
  view.inbox = { ...view.inbox, id, name, kind, ownerAgentId: kind === 'agent' ? 'agent_milo' : null, parentInboxId: kind === 'agent' ? 'inbox_root' : null };
  view.requester = { id: 'human_preview', auth: { provider: 'local', assurance: 'mfa' } };
  if (kind === 'workspace') { view.agents = []; view.caseQueue = []; view.cases = []; view.assets = []; }
  views[id] = id === 'inbox_iris' ? JSON.parse(JSON.stringify(view).replaceAll('agent_milo', 'agent_iris').replaceAll('Milo', 'Iris')) : view;
}
await server.listen();
console.log('Synthetic inbox startup fixture: http://127.0.0.1:5187/app');
