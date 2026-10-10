# GA4 local FileStore runner

This runner exercises the production `startConnection`, `EnvoiConnector` and
`FileBridgeStore` from one explicitly selected combined Envoi server/client tree.
It starts the real server through `npm start` with disposable FileStore data and
development-auth actors. The controlled adapter records a durable local effect;
it does not start a provider or a real Hermes/OpenClaw host.

Run from PowerShell in the runner worktree, with dependencies installed. The
target must also have dependencies installed and a clean, committed production
tree with its generated bundles. Replace both values with the exact combined
integration worktree and full integration SHA when Lane A integrates N1.

```powershell
$env:ENVOI_GA4_TARGET_ROOT = 'C:\absolute\path\to\combined-envoi-worktree'
$env:ENVOI_GA4_SHA = '<full 40-character combined integration SHA>'
npx vite build --config integrations/gates/ga4-worker.vite.config.mjs
if ($LASTEXITCODE -ne 0) { throw 'GA4 worker compilation failed' }
node integrations/gates/ga4-local.mjs
if ($LASTEXITCODE -ne 0) { throw 'GA4 FileStore failed' }
```

The worker is bundled separately against the target's production source, using
absolute aliases. Its build records the source SHA and bundle hash. The driver
rejects a different target/SHA, dirty production files, a changed worker bundle
or a download hash that disagrees with `release.json`. It never rebuilds or
modifies the target's production files or generated downloads.

The sequence is:

1. Start with a real SSE connection. Fail one handler attempt before producing
   an effect, and confirm the real server persists a retryable claim with a
   future deadline. The server retry base is set to 20 seconds so the deadline
   survives process shutdown and restart. Client clocks, timers, jitter and
   retry policy are unchanged.
2. Close the active SSE sockets at an HTTP proxy. Reject every subsequent SSE
   connection by closing its socket; forward REST normally. Stop the connector,
   deliver another message while it is offline, then restart from its saved
   credentials, inbox cursor and work ledger.
3. Observe the real idle claim's `nextAvailableInMs`. The offline arrival and
   retry-delayed work must each produce one effect and one successful processed
   receipt, with their server work claims completed. The failed attempt is
   recorded separately and must not have produced an effect.
4. Keep SSE blocked. Observe two later idle safety claims, restart again, and
   observe another safety claim. Recheck effects and completion requests for
   duplicates, and identity, credentials and inbox cursors for preservation.

Acceptance additionally requires zero SSE frames/bytes after the cut, zero delta
requests and no new durable wake event after the offline message was delivered.
Creating that offline message naturally creates its initial durable events; none
are delivered to the connector during recovery. No manual claim or event trigger
is injected. Exclusive effect creation detects duplicate processing rather than
suppressing it. Allow roughly two minutes for production safety intervals.

Successful evidence is written to `evidence/ga4-<sha-prefix>/summary.json`. It
contains counts and verification flags, without HTTP payloads, credentials or
actor identifiers. Failure details stay in ignored `result.json`. Disposable
data, saved credentials and owned processes are cleaned up on either outcome.

The initial rehearsal targets paired validation PR #58 at
`2b6dec971ee6dff3c01cec98d1955506e3569b05` (N1-client `aeee41c`, N1-server
`8588a90`, integrated B-2 `87bdf46`). That is rehearsal evidence. Formal GA4 must
be rerun on the combined integration SHA. Lane A adds PostgreSQL CI and posts
the authoritative `GATE GA4` under build-plan §6.
