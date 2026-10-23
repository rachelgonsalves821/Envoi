# Private installer and background-operation preparation

Task B-4-packaging-background-prep, Rachel / Codex, Lane B. Original PR #111 base: `7442248d16635c2256c11bf02dcaf493ca4fe039`, not a current Gate B-local instruction. Assigned on build-board #34 before implementation. Only new `integrations/distribution/**` files belong to this task. The current Phase B team owns the existing helper, connector, contract, UI, root build and release paths.

This preparation consumes the existing agent-registration v1 revision 3 helper and connector unchanged. It creates a private local package, verifies artifact checksums before installing files, and prepares service lifecycle operations using the existing connector service definitions. It does not publish downloads, modify the frozen candidate, register services, enroll an agent or run a real runtime.

Follow-up task B-4-install-hardening carries PR #111 unchanged as a dependency on integration base `984051f`. Its only new scope is new-install-directory protection and interruption tests within this directory. Je owns the current Gate B-local candidate; no version in this document is an instruction to restart or downgrade it.

## Prepare a private package

Build the repository using its existing `npm run build`. The reviewed build emits `integrations/onboarding/dist/envoi-link.mjs`, its sibling `envoi-connector.mjs`, and `private-release.json`. The normal root build is owned by Lane A; no root build changes are required here.

Record the SHA-256 of `private-release.json` from that trusted local build independently. This pin authenticates the selected manifest against the operator's expected value; it is not a publisher signature. Before public distribution, Lane A must decide how a release manifest is authenticated and attach its source SHA and acceptance evidence. Downloading a file and its checksum from one untrusted location does not establish publisher identity.

The committed standalone `private-directory.mjs` is generated from the EXISTING connector `privateDirectory` helper via `private-directory.ts`, not an independent ACL policy. Preparation and a regression test rebuild it in memory and reject drift before creating package output. If its reviewed source changes, run `npm --prefix integrations/distribution run build:private-directory` and review the generated diff. The preparer uses the repository's existing Vite dependency; the resulting local installer requires Node only and no repository checkout or build tooling.

From the repository root, prepare a NEW output directory:

```powershell
node integrations/distribution/prepare.mjs --source integrations/onboarding/dist --output integrations/distribution/dist --manifest-sha256 <approved-64-character-sha256>
```

The source manifest must remain private/unpublished and match the approved contract. Only the two allowlisted helper artifacts are copied from the source. Installer files come from this reviewed distribution directory; credential journals, environment files, sessions and runtime configuration are never packaged. Symlinked directories, linked files, changed artifacts and unexpected manifest entries are rejected. Output is deliberately local and ignored by Git.

## Local installer preparation

After package review, these are the candidate local-file installation commands. They are not public curl-pipe installers and have no download logic. Their scripts must come from the trusted reviewed checkout. The destination must be NEW, with an existing parent in a trusted account-owned location, separate from every agent's private state directory. Do not use shared writable locations.

macOS/Linux:

```sh
sh /trusted/private-bundle/install.sh --bundle /trusted/private-bundle --destination /trusted/new-envoi-version --manifest-sha256 <approved-sha256>
```

Windows PowerShell:

```powershell
& C:\trusted\private-bundle\install.ps1 --bundle C:\trusted\private-bundle --destination C:\trusted\new-envoi-version --manifest-sha256 <approved-sha256>
```

Node.js 22 or newer must already exist. No administrator elevation, shell-profile edit, PATH edit, automatic prerequisite download or runtime/provider modification is performed. The installer verifies the pinned manifest and both complete artifacts in memory before creating the destination. It refuses an existing directory BEFORE applying permissions. Only the newly-created empty directory is passed to the existing account-only protection helper: Windows replaces inherited/explicit grants with the current account SID, while POSIX uses mode 0700. If protection fails, no artifacts or completion record are written. Source, parent, existing installations and private agent state are never permission targets.

After protection, the installer writes the two artifacts and manifest, re-verifies persisted checksums, and writes `installation.pending.json` before committing `installation.json` by rename. Protection, partial-write, persisted-integrity or rename failures reject rather than return success. A partial new directory (possibly containing pending metadata) is preserved without a completed marker. Retry only with another NEW destination; the installer never repairs, removes or changes permissions on existing installations or credential stores. This is logical interruption detection, not a guarantee against power-loss/filesystem corruption; no automatic rollback or upgrade is implemented.

The installer result explicitly reports `connected:false` and `serviceInstalled:false`. It does not run the helper. Once real-host acceptance is separately authorized, use the installed Node entry point for the existing interactive Phase B flow. The established helper still owns native approval confirmation, credentials, activation recovery and foreground operation.

This package currently supplies no global `envoi-link` shim. A public two-command experience needs reviewed platform launchers, versioned download/authentication wiring and PATH guidance. Those are listed below as release work; the example commands above describe the implemented local package only.

## Background lifecycle

`background.ts` exposes `backgroundPlan(action, directory, options)`. It imports `connectorService` from the existing connector rather than copying its systemd, launchd or Task Scheduler manifests. Service identity remains tied to the same canonical saved-state directory and runtime.

| Action | Prepared order |
| --- | --- |
| install | Confirm activated installation; acquire/release existing connector lock; write the existing service definition; register/start with existing commands |
| start | Confirm installed definition and activated runtime; acquire/release existing connector lock; enable/start the existing supervisor |
| stop | Disable supervisor/restarts; request authenticated connector shutdown; require the existing lock to become available |
| restart | Complete stop and require released lock before enable/start |
| uninstall | Complete stop and require released lock; remove only the supervisor registration/definition |

`executeBackgroundPlan` requires an explicitly supplied executor. There is no built-in process executor or service-installing command in this milestone. Tests provide inert commands plus the REAL existing `acquireConnectorLock` when proving single-owner behavior. Integration must bind inspection to the existing saved connection/activation metadata, shutdown to the authenticated local control channel, and locking to `acquireConnectorLock`. Any bounded wait must fail if the owner remains alive. Never delete a live lock, duplicate credentials, force a reconnect, refresh from another process, or register a replacement agent to get past a conflict.

The running connector also acquires the existing lock, which is the final ownership guard if another foreground process starts between the management check and supervisor start. Every stop/restart failure must stop the sequence before a new start. Windows plans disable scheduled restarts before requesting graceful shutdown and do not use `/End` to kill a possibly unrelated process. Linux/macOS supervisor shutdown and Windows user tasks still require real-host acceptance.

All lifecycle operations preserve session, helper activation journal, cursor, work receipts and connector executable. Uninstall removes the startup definition only. Credential revocation remains an owner action in Envoi. Starting a supervisor does not prove runtime readiness or message processing. Services run under the existing user, at user login; operation after logout, sleep or machine shutdown is not promised. The runtime/Gateway itself must also remain available.

## Tests

Run from PowerShell at the repository root:

```powershell
npm --prefix integrations/distribution test
npx tsc --noEmit -p integrations/distribution/tsconfig.json
git diff --check
```

The package test command anchors configuration and test discovery at the repository root. Running `npm test` inside `integrations/distribution` invokes the same focused distribution suite.

Fixtures use new temporary package directories and fake artifact content. No service manager, real agent/runtime, model, enrollment endpoint or hosted environment is invoked. The single-owner test uses the current connector lock implementation and checks that service start is refused while an owner holds it. The lifecycle executor tests verify ordering and failure handling, not operating-system supervisor behavior. Windows sandbox restrictions can block atomic rename and junction fixtures; record the restriction and rerun unchanged tests outside the sandbox rather than skipping assertions.

Hardening coverage injects protection failures, partial writes at every file stage, corrupted persisted bytes and completion-rename failure. It verifies no completed marker, source/state preservation, refusal to reuse partial directories, and successful fresh retry. A packaged CLI test runs outside the repository with fake artifacts. On Windows, a separate real ACL check is confined to disposable fixture directories and verifies current-SID-only grants plus unchanged parent ACLs; POSIX checks file/directory modes. Platform-specific skips do not establish acceptance of another platform or of a real service/runtime.

## Integration requests and open release items

1. Lane A/Phase B team review the scope and compatibility after the frozen Gate B-local run. This task branch is not an acceptance candidate and must not be deployed over that run.
2. Prove real Hermes/OpenClaw onboarding and same-identity recovery on the selected candidate. The prior 207/207 loopback/controller checks were at `dcd2960` with inert adapters; they are not proof of real-host acceptance at `7442248`.
3. Bind the prepared executor to the existing credential/control/lock and service-manager implementations in a separately assigned helper/connector change. Avoid editing those shared files concurrently with acceptance work. Add bounded supervisor checks and idempotent handling of an already-stopped or absent service.
4. Design the foreground-to-background handoff. Complete human confirmation and activation, stop the foreground owner cleanly, retain its state, and start the same installation under supervision. No second refresh/claim owner may run during handoff. Test cancel/failure and restart around this boundary.
5. New Windows install directories now reuse the existing account-only helper and fail closed on protection errors, with a standalone-source drift guard and disposable-directory ACL evidence. Existing installations are deliberately not migrated or permission-modified; upgrades and real-host service acceptance remain separate work.
6. Add platform launchers and authenticated, versioned release manifests with acceptance/source evidence. Review artifact provenance, downgrade/rollback policy, interrupted installation, upgrade of a running connector and uninstall behavior before public distribution. Automatic updates are outside this preparation.
7. Lane A owns any download routes, root build/config, production-origin configuration and release wiring. No speculative public installer URL should be shown as working.
8. Obtain separate authorization for service installation on disposable real hosts, then prove terminal closure, login/restart, offline catch-up, pause and revoke for each platform advertised. Label unsupported persistence honestly.
9. Update `/connect` and the skill only after the corresponding installer/route is accepted. Continue one registration/claim/activation flow. Remote MCP/OAuth remains a separate Phase B task; Phase C is not changed.

Rollback for this preparation: discard the task branch or revert its new distribution directory; shared runtime and contract bytes are untouched. Temporary fixture installations contain no credentials. Future real installations must preserve all existing private state when rolling back binaries or removing startup registration.
