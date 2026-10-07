import { assertSafeIdentifier, assertSafeRequestTarget } from './path-safety.js';
import { createInboxFolder, getPrefsForCases, updateCaseInboxPreferences } from './inbox-preferences.js';

const requestError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function attachInboxPreferencesToView(view, projection) {
  return {
    ...view,
    folders: projection.folders,
    caseQueue: view.caseQueue.map(workCase => ({ ...workCase, inboxPreference: projection.inboxPreferences[workCase.id] }))
  };
}

export function createInboxPreferencesHttp({ store, requireHuman, requireInboxAccess, requireCaseAccess, readBody, writeJson, mutationAuthorization }) {
  if (!store || ['getJson', 'putJson', 'withTransaction', 'id', 'now'].some(name => typeof store[name] !== 'function')) {
    throw new TypeError('A durable preference store is required');
  }
  for (const [name, callback] of Object.entries({ requireHuman, requireInboxAccess, requireCaseAccess, readBody, writeJson })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} callback is required`);
  }
  if (mutationAuthorization !== undefined && typeof mutationAuthorization !== 'function') throw new TypeError('mutationAuthorization must be a function');

  async function validatedContext(req, inboxId, human) {
    assertSafeIdentifier(inboxId, 'inboxId');
    if (!human) throw requestError(401, 'Verified human session required');
    assertSafeIdentifier(human.id, 'humanId');
    const inbox = await requireInboxAccess(req, { human, inboxId });
    if (!inbox) throw requestError(403, 'Active workspace access required');
    if (inbox.id !== inboxId) throw requestError(403, 'Workspace access does not match the requested inbox');
    const organizationId = assertSafeIdentifier(inbox.organizationId, 'organizationId');
    return { human, inbox, scope: { scopeMode: 'personal', organizationId, humanId: human.id, inboxId } };
  }

  async function validatedCase(req, context, caseId) {
    assertSafeIdentifier(caseId, 'caseId');
    const workCase = await requireCaseAccess(req, { human: context.human, inbox: context.inbox, caseId });
    if (!workCase || workCase.id !== caseId) throw requestError(404, 'Case not found in this inbox');
    return workCase;
  }

  async function handleRequest(req, res, url = new URL(req.url, 'http://localhost')) {
    if (req.method !== 'POST') return false;
    const folderRoute = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/inbox-folders$/);
    const caseRoute = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/cases\/([^/]+)\/inbox-preferences$/);
    const match = folderRoute || caseRoute;
    if (!match) return false;
    try { assertSafeRequestTarget(req.url); }
    catch (error) { throw requestError(400, error.message); }
    const inboxId = assertSafeIdentifier(decodeURIComponent(match[1]), 'inboxId');
    const caseId = caseRoute ? assertSafeIdentifier(decodeURIComponent(caseRoute[2]), 'caseId') : null;
    const human = await requireHuman(req);
    if (!human) throw requestError(401, 'Verified human session required');
    const input = await readBody(req);
    const context = await validatedContext(req, inboxId, human);
    const authorization = mutationAuthorization ? await mutationAuthorization(req, { human: context.human, inbox: context.inbox, caseId }) : null;
    if (mutationAuthorization && (!authorization || !Array.isArray(authorization.lockKeys) || typeof authorization.authorize !== 'function')) {
      throw new TypeError('mutationAuthorization must return lockKeys and an authorize callback');
    }
    if (folderRoute) {
      const folder = await createInboxFolder(store, context.scope, input, authorization ?? {});
      await writeJson(res, 200, { folder: { id: folder.id, name: folder.name } });
    } else {
      const workCase = await validatedCase(req, context, caseId);
      const options = {
        lockKeys: authorization?.lockKeys ?? [],
        authorize: async () => {
          if (authorization) await authorization.authorize();
          return { workCase: await validatedCase(req, context, caseId) };
        }
      };
      const { updatedAt, ...inboxPreference } = await updateCaseInboxPreferences(store, { ...context.scope, caseId }, workCase, input, options);
      await writeJson(res, 200, { inboxPreference });
    }
    return true;
  }

  async function projectHumanView(req, { inboxId, view }) {
    const human = await requireHuman(req);
    const context = await validatedContext(req, inboxId, human);
    if (!view || !Array.isArray(view.caseQueue)) throw requestError(400, 'HumanView caseQueue must be an array');
    if (view.inbox && (view.inbox.id !== context.inbox.id || view.inbox.organizationId !== context.inbox.organizationId)) {
      throw requestError(400, 'HumanView does not match the validated inbox');
    }
    for (const workCase of view.caseQueue) await validatedCase(req, context, workCase?.id);
    const projection = await getPrefsForCases(store, { ...context.scope, cases: view.caseQueue });
    return attachInboxPreferencesToView(view, projection);
  }

  return { handleRequest, projectHumanView };
}
