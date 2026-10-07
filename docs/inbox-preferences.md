# Human inbox preferences

`src/inbox-preferences.js` provides durable human annotations independent of agent
case state. Every caller must explicitly select `scopeMode: 'personal' | 'shared'`;
there is no default in the generic helpers. The user confirmed personal Gmail-like
scope. The HTTP adapter explicitly selects personal mode; shared mode remains
available to explicit generic callers without changing the active product scope.

## Route boundary

The lead's routes must authenticate a human and validate active organization
membership, inbox access, inbox organization, and case existence before calling
these helpers. Derive `organizationId` and `humanId` from validated server context,
never the request body. Helpers validate identifiers and input, but do not grant
access or alter sessions, revocation, policy evaluation, or authentication.

Exports (all scope arguments include `scopeMode`):

- `listInboxFolders(store, { organizationId, humanId })` returns folder records.
- `createInboxFolder(store, { organizationId, humanId }, { name })` returns the
  existing or newly created folder record.
- `updateInboxFolder(store, scope, folderId, { name })` renames a folder. A
  normalized duplicate name returns 409; an absent folder returns 404.
- `deleteInboxFolder(store, scope, folderId)` returns `{ deleted: boolean }`.
  Deletion is idempotent. Deleted folder assignments project as `folderId: null`
  without rewriting annotations, affecting read state, or moving out of Done.
- `getCaseInboxPreferences(store, { organizationId, humanId, inboxId, caseId }, caseRecord)`
  returns `{ folderId, read, archived, readThrough, revision, updatedAt }`.
- `updateCaseInboxPreferences(store, scope, caseRecord, patch)` returns that same
  projection. `caseRecord.id` must equal `scope.caseId`.
- `clearCaseInboxPreferences(store, scope, caseRecord)` resets folder/read/Done
  preferences to defaults without changing the case.
- `caseReadMarker(workCase)` returns a semantic-digest revision for the case's
  timeline and latest message content, including `events`, `messages` when
  supplied, `latestMessage`, and `updatedAt`/`createdAt`. `timeline` is a fallback
  when `events` is absent. It always returns a string, including
  for an empty timeline. Canonical object-key ordering makes it stable across
  persistence and restart. Array order and event/message IDs are significant.
- `getPrefsForCases(store, { organizationId, humanId, inboxId, cases })` returns
  `{ folders: [{ id, name }], inboxPreferences: { [caseId]: { read, archived,
  folderId, readThrough, revision } } }`. The lead attaches the record at
  `inboxPreferences[workCase.id]` as `inboxPreference` to each display copy in
  `HumanView.caseQueue`, and attaches `folders` to the response. Helpers never
  mutate input cases or canonical stored cases. Use the same case representation
  for GET revision calculation and POST comparison.

`GET /api/organizations/:orgId/inbox-preferences` can wrap folders in `{ folders }`.
The corresponding POST accepts `{ name }`. The case POST accepts only
`{ folderId?: string | null, read?: boolean, archive?: boolean, readThrough?: string }`.
Errors use `statusCode: 400` for invalid input, identifiers, or cursors and
`statusCode: 404` for a folder absent from the validated scope.

## Explicit storage scope and validation

Scope construction is isolated in `preferencePaths`. Personal scope requires
`organizationId` and `humanId`; its root is
`human-inbox-preferences/<organizationId>/personal/<humanId>`.
Shared scope requires `organizationId` and `inboxId`; its root is
`human-inbox-preferences/<organizationId>/shared/workspaces/<inboxId>`.
Shared folder and annotation records are visible to all authorized humans in that
workspace. `humanId` does not affect shared storage. Every annotation scope also
requires `inboxId` and `caseId`. Under each root use `folders.json` and
`inboxes/<inboxId>/cases/<caseId>.json`.
Use `assertSafeIdentifier` for every identifier before constructing document paths.
Use only `store.getJson`, `store.putJson`, and `store.withTransaction`; acquire the
folder-document and annotation-document lock keys together for case mutations.
Folder creation serializes on the scoped folder document to deduplicate retries.
Lock keys hash document paths to stay below the store's 512-character key limit
even when every identifier reaches its maximum length. All projection GET helpers
perform zero writes. Annotation records contain only `folderId`, `archived`,
`readThrough`, and `updatedAt`; there is no observed-revision history or cache.

Normalize names with Unicode NFKC, trim, and collapse whitespace. Reject control
characters and blank names. Bound both raw and normalized names to 80 Unicode
code points; deduplicate by normalized lowercase name. Preserve the first display
name and ID on duplicate creation. Generate IDs with `store.id('folder')`, and
timestamps with `store.now()`. Reject unknown patch fields, non-object/array
bodies, nonboolean read/archive values, and nonstring/non-null folder IDs.
Omitted fields preserve stored values; `folderId: null` clears folder assignment.
Folder assignment must resolve inside the current organization/human scope.

## Read and Done semantics

`read` describes whether this human has seen the current event version. It is
independent of `needsAttention`, `bucket`, and protocol task state. A new annotation
defaults to unread, unarchived, and no folder. `read: true` without a marker records
the current revision for compatibility; the UI must always provide the observed
revision from its last response. `read: false` clears the acknowledgement.
`readThrough` is allowed only together with `read: true` and must be a lowercase
64-character SHA-256 hexadecimal digest. Accept any syntactically valid digest;
it is an acknowledgement, not an authorization token. Read is computed solely by
equality with the current revision. A stale or arbitrary unequal marker therefore
leaves the case unread. No issued-marker registry is needed.
The frontend sends `{ read: true, readThrough: annotation.revision }` only when
the human clicks that conversation; refreshing or listing cases does not mark
them read. A server write response can return persisted state; the frontend then
awaits refresh to obtain the effective projection.

Account for every timeline event and latest message in the digest; a later event
with the same or an earlier timestamp still makes the conversation unread. The
lead must supply complete visible event/message content, or update the case
`updatedAt` on every new message if messages are absent from the case projection.
An invisible new message with neither an event nor a revision change cannot be
detected from a case record alone. Do not substitute `needsAttention` or wall-clock
read time for a content revision. An empty case can be acknowledged; its first
event changes its revision and makes it unread. Repeated read requests for the
same revision and unchanged patches should preserve `updatedAt`.

The user confirmed **Done** means moving a conversation out of the main inbox
into the Done inbox. Mutation input uses `archive: true` for this action and
`archive: false` to move it back. Done neither completes nor pauses the task,
changes no case events, and grants or revokes no authority. New events may make
a Done conversation unread, but its Done annotation stays set until explicitly
cleared. Response annotations use `archived` to match `HumanView`. Moving back
preserves its folder assignment and read acknowledgement.

## HTTP adapter and HumanView wiring

`createInboxPreferencesHttp` in `src/inbox-preferences-http.js` requires
`{ store, requireHuman, requireInboxAccess, requireCaseAccess, readBody, writeJson }`
and returns `{ handleRequest, projectHumanView }`. Required callbacks:

- `requireHuman(req)` returns the server-authenticated human or throws an HTTP
  error. A null result becomes 401. Do not interpret agent credentials as humans.
- `requireInboxAccess(req, { human, inboxId })` returns the matching inbox with its
  trusted `organizationId`, after checking active membership and inbox access.
  Throw the server's existing 403/404 errors on denial. This runs on every mutation
  after body reading and on every projection request; a null result becomes 403.
- `requireCaseAccess(req, { human, inbox, caseId })` returns the existing accessible
  case from this inbox or throws. A null or mismatched case becomes 404. Supply the
  same event/message representation used for GET marker calculation: load the raw
  case, validate access/existence, then return `projectCaseForHuman(rawCase)`.
  GET currently uses `projectWorkspaceForHuman(cases).cases`, which calls that same
  projection. Do not return only `store.getJson(...)` from the POST callback.
- `readBody(req)` is the server's bounded JSON-body reader. `writeJson(res, status,
  body)` is the existing response writer; the adapter leaves session/header handling
  to that writer and the surrounding server.

Call `await handleRequest(req, res, url)` from the parent server dispatch. It returns
`true` after writing a matched response, `false` for other methods/routes, and throws
errors with `statusCode` to the parent's existing error boundary. Endpoints:

- `POST /api/inboxes/:id/inbox-folders` accepts `{ name }`, returns 200 with
  `{ folder: { id, name } }`, and deduplicates normalized-name retries.
- `POST /api/inboxes/:id/cases/:caseId/inbox-preferences` accepts the documented
  patch, returns 200 with `{ inboxPreference: { read, archived, folderId,
  readThrough, revision } }`, and never changes protocol-case state.

Body fields cannot select scope or supply trusted organization/human IDs. The
adapter derives them exclusively from the required authenticated callbacks.

### Mutation authorization race

Outer callbacks alone leave a gap while waiting to enter the preference transaction.
To support the parent's lock-backed authorization boundary, the adapter accepts an
optional `mutationAuthorization(req, { human, inbox, caseId })` callback. Resolve
session identity/lease and any refresh work here, outside the mutation transaction.
Return `{ lockKeys: string[], authorize: async () => void }`. The preference helper
acquires these keys alongside its folder/annotation keys, then invokes `authorize`
inside the transaction before any preference document reads or writes. Throw on
expired/revoked session, inactive membership, or unavailable inbox access. Do not
return a boolean as a substitute for throwing on denial. A configured callback
that fails to return both fields is rejected, with no write fallback.

The parent must supply the same keys used by the actual revocation/removal writers.
For WorkOS session revocation, `auth.sessionKey(sessionId)` is the existing key;
case/inbox mutation writers use `inbox:<inboxId>:mutations`. Local membership changes
need a shared locking convention with their writers as well. Preference-only keys
do not serialize authorization changes. Without `mutationAuthorization`, the adapter
retains the outer-callback contract and does **not** close this race.

Repeating `auth.getHuman(req)` is insufficient for WorkOS: it memoizes the human on
the request. Recheck the durable session lease with `auth.validateSessionLease(lease)`
or the corresponding fresh session API, and reread local membership/inbox state.
Provider membership lookup also caches per human/request by default; a required
fresh provider check must bypass that cache, for example via the existing
`{ maxAgeMs: 0 }` option. Local locks cannot make an external provider's membership
state atomic with a local commit; that check remains a point-in-time provider
decision. Avoid initial authentication/refresh inside the transaction: its own
session/human transactions can request extra keys and violate nested-lock rules.

After the authorization hook, case writes call `requireCaseAccess` again inside the
transaction, obtaining the current projected case for the response comparison.
They preserve an explicit observed `readThrough`; newer unseen events remain unread.
Generic `createInboxFolder` and `updateCaseInboxPreferences` also accept a final
`{ lockKeys, authorize }` option. For a generic case write, `authorize` may return
`{ workCase }` to supply a freshly validated case snapshot under those locks.

The adapter's localhost tests use injected identity/access callbacks. They verify
callback ordering, scoped persistence, projection behavior, and supplied lock hooks;
they do not establish production tenant/session authorization. The server now wires
the adapter with current session, account, membership, inbox and case checks under
the existing inbox/case and WorkOS session-revocation locks. The real-server tests
in `test/inbox-preferences-integration.test.js` exercise actual human sessions,
same-organization isolation, CSRF, insufficient assurance and agent/nonmember denial.

### Marker consistency

`projectCaseForHuman` retains the original `events` array and emits a separate derived
`timeline`. The digest prefers `events`, so derived actor/summary fields do not alter
the normal GET/POST marker. However, projection drops raw `messages`/`latestMessage`
properties, and a timeline-only raw representation hashes differently from projected
`events: []`. Returning the projected case from POST prevents those shape mismatches.
New messages must still be represented in visible case events or its `updatedAt`;
the adapter cannot detect a message omitted from both the displayed timeline and its
revision inputs. Regression tests exercise the actual projection functions.

For callers without an already validated view, `projectHumanView(req, { inboxId, view })`
validates human/inbox/case access and returns a new view with `folders`
and an `inboxPreference` on each copied `caseQueue` entry. It leaves `view.cases` and
all canonical cases untouched. Revisions describe the **displayed** case snapshots;
case-validation callbacks do not silently replace them with newer unseen events.
The projection writes no documents. `attachInboxPreferencesToView(view, projection)`
is also exported as a pure copy helper for already validated callers.
The server's authenticated `human-view` route uses `getPrefsForCases` with trusted
personal scope and the existing own-inbox history projection, then this pure helper.
It avoids redundant per-case authorization/storage reads and does not mark cases read.

`frontend/src/inbox-preferences.ts` exports pure `filterInboxCases`, `selectInboxCase`,
and `readAcknowledgementForCase`. Main excludes archived conversations, Done uses
only the archive annotation, and filters can intersect read and folder selection.
Selection does not automatically fall back to another case or mark it read. Call
`readAcknowledgementForCase(clickedCase)` only on a human click; POST the returned
revision snapshot, await the response, then refresh. It returns null if the server
revision is unavailable and never invents a marker or changes local read state.

## Verification

Run `node --test test/inbox-preferences.test.js`. Coverage includes durable restart,
concurrent normalized folder creation, explicit mode validation, personal and
shared isolation, folder CRUD, annotation reset, patch validation, stale markers,
equal/backdated timestamps, latest messages, empty cases, Done/move-back, unchanged
protocol documents, and zero projection writes. Route authorization tests remain
the lead's responsibility. The standalone HTTP adapter is covered by
`node --test test/inbox-preferences-http.test.js`, including real localhost requests,
trusted callback boundaries, private scope, restart, stale markers, and pure GET.
Run frontend checks with
`npm run test:frontend -- frontend/test/inbox-preferences.test.ts`.
The parent owns production server dispatch wiring; this work changes no `server.js`
and executes no external integrations.
