# Mac migration: source recovery handoff

Prepared 2026-11-18 for the owner moving from Windows to macOS. This packet preserves reviewed local source work that a normal clone would miss. It does not contain Codex chats, credentials, local runtime state, or an approved product release.

Reviewed product baseline: `main @a7c4f2fdf1587b9d1b582789431a4027ffe7f3e7`. Integration baseline: `integration/agent-native @cf1ad3536de304dd2e24886196398ffb1e92f292`. Repository: https://github.com/rachelgonsalves821/Envoi (formerly Sinaloa).

## Start on the Mac

Clone the repository and fetch its branches. Normal development can start from the current product code; consult this packet when a task needs old work. For implementation, follow AGENTS.md, create your own worktree/task branch from the current integration branch, consume only approved contracts, and leave release decisions to the owner.

```sh
git clone https://github.com/rachelgonsalves821/Envoi.git
cd Envoi
git fetch origin
git worktree add ../envoi-migration-reference --detach origin/lane-b/mac-migration-20261118
```

Give the new Codex this instruction:

> Read `integrations/gates/mac-migration-20261118/README.md` and `inventory.json` in the migration reference worktree. Use current main and approved integration contracts as the baseline. The archive contains historical alternatives and unfinished drafts; identify a specific needed change before porting it. Do not merge an archive branch or apply all snapshots wholesale.

## What is already covered

- 108 commits on 29 local branches were outside every live fetched remote branch/tag at review time. Stable Git patch IDs match 43 of them to main and 71 to integration; those counts overlap.
- Ten of the 29 branches have every missing commit patch-equivalent to main. They need no separate archive branch. Exact commit IDs differ after rebases/cherry-picks; the patch-equivalent commit IDs are recorded in inventory.json.
- 271 inspected source file versions match current main or integration exactly. A further 111 match blobs already reachable in main history. Their blob IDs are recorded; those are recoverable with `git cat-file blob <git_blob>` after cloning.
- The previously highlighted source in the owned-ACL composition worktree is already represented in main/history. The older onboarding verification worktree also has no unique uncommitted source blobs.
- AGENTS.md and CLAUDE.md in the primary checkout match main. Its local build plan already exists in main history. Its only other changes are an npm lockfile peer-metadata deletion and an empty test stub; neither warrants a source recovery patch.

Patch equivalence is not a proof that an old design should be reintroduced. Where no exact equivalent was found, preservation is conservative: it means the material remains available for review, not that main is missing a required feature.

## Preserved uncommitted source

Nine patches preserve 34 unique source/document file versions. Where necessary they include 14 companion source versions already present in Git history, so each patch reconstructs a coherent source snapshot at its recorded base. Build output is excluded and must be regenerated with npm run build if an approved change is later ported.

| Snapshot | Unique / companion files | Review disposition |
| --- | ---: | --- |
| [03-phase-c-current-closeout-progress](snapshots/03-phase-c-current-closeout-progress.patch) | 1 / 0 | Historical Phase C progress/evidence notes; dated observations, not current release authority. |
| [05-phase-c-server-adoption](snapshots/05-phase-c-server-adoption.patch) | 3 / 0 | Adds caseId and agentId matching to accepted-checkpoint retention and its regression fixtures. Review against current code before porting. |
| [08-hermes-live-preflight-fix](snapshots/08-hermes-live-preflight-fix.patch) | 2 / 0 | Draft hosted-provider acceptance and Hermes/OpenClaw testing/release guides. Historical instructions require current owner approval. |
| [09-b-4-1-private-helper](snapshots/09-b-4-1-private-helper.patch) | 7 / 6 | Older private onboarding helper draft, including CLI, local confirmation, state/store and tests. Current onboarding has evolved; do not replace it wholesale. |
| [11-phase-c-openclaw-startup](snapshots/11-phase-c-openclaw-startup.patch) | 15 / 8 | Mixed Hermes/OpenClaw continuation, request-budget and R3 file-admission drafts, plus progress/promotion notes. Deferred work is not approved by this archive. |
| [14-seed-scenario](snapshots/14-seed-scenario.patch) | 2 / 0 | Unpublished demo scenario script and request for a files-page feature. Demo setup is not an instruction to run a real host. |
| [15-ci-audit-picomatch-exception](snapshots/15-ci-audit-picomatch-exception.patch) | 2 / 0 | Lane A draft audit-exception evaluator and tests. Build-board #34 records that the CI policy decision is pending. The active CI gate is unchanged. |
| [16-same-org-agent-label](snapshots/16-same-org-agent-label.patch) | 1 / 0 | Lane A request describing same-organization counterparty labels. Main still contains the another-organization fallback; this is a follow-up proposal, not an applied fix. |
| [19-a-3-0-a5-presence-contract](snapshots/19-a-3-0-a5-presence-contract.patch) | 1 / 0 | Historical Lane A handoff note. Current contracts, main and build-board approvals take precedence. |

The inventory records each patch SHA-256, original base commit, unique files and companion files. Each patch was applied to a temporary Git index at that base and every reconstructed source blob was checked against its original blob ID. This checks recovery integrity; it does not establish that the archived draft passes current product tests.

To inspect the helper snapshot in isolation (from the clone directory):

```sh
packet="$(cd ../envoi-migration-reference && pwd)/integrations/gates/mac-migration-20261118"
git worktree add ../envoi-recovered-helper --detach 2b18170d59b0096ff997d9a79487d50ccb627ef9
git -C ../envoi-recovered-helper apply --check "$packet/snapshots/09-b-4-1-private-helper.patch"
git -C ../envoi-recovered-helper apply "$packet/snapshots/09-b-4-1-private-helper.patch"
```

For another snapshot, use its base and patch path from inventory.json. Any implementation work belongs in a new approved task branch. Lane A source, scripts, root configuration and contracts remain Lane A-owned; their text is preserved only inside archival patch files under integrations/gates.

## Branch review

Nineteen remote archive branches preserve local histories not fully patch-equivalent to main. Two additional archive branches retain detached owner-permission and R2-journal verification variants. All use `codex/mac-migration-20261118/` followed by the source label; no existing branch is rewritten.

| Original branch | Missing commits / not equivalent to main | Disposition |
| --- | ---: | --- |
| `backup/http-wake-250a377` | 2 / 2 | Archived at `codex/mac-migration-20261118/backup/http-wake-250a377` |
| `codex/bc-native-gateway` | 4 / 0 | Covered by main patches |
| `codex/bc-provider-clients` | 5 / 0 | Covered by main patches |
| `codex/bc-provider-wake` | 12 / 0 | Covered by main patches |
| `codex/n1-paired-validation` | 3 / 3 | Archived at `codex/mac-migration-20261118/codex/n1-paired-validation` |
| `codex/phase-c-current-closeout-progress` | 11 / 11 | Archived at `codex/mac-migration-20261118/codex/phase-c-current-closeout-progress` |
| `codex/phase-c-staging-acquisition-restoration-1f773` | 1 / 1 | Archived at `codex/mac-migration-20261118/codex/phase-c-staging-acquisition-restoration-1f773` |
| `codex/phase-c-staging-admission-restoration` | 1 / 1 | Archived at `codex/mac-migration-20261118/codex/phase-c-staging-admission-restoration` |
| `codex/ra-b1-before-final-parent-c793` | 9 / 4 | Archived at `codex/mac-migration-20261118/codex/ra-b1-before-final-parent-c793` |
| `lane-a/A-4.4-connect-routing` | 2 / 1 | Archived at `codex/mac-migration-20261118/lane-a/A-4.4-connect-routing` |
| `lane-b/B-4.2-claim-ui` | 1 / 0 | Covered by main patches |
| `lane-b/B-4.3-activated-runtime` | 2 / 0 | Covered by main patches |
| `lane-b/B-C-contract-consumer-review` | 7 / 7 | Archived at `codex/mac-migration-20261118/lane-b/B-C-contract-consumer-review` |
| `lane-b/N2-browser-contract-review` | 1 / 0 | Covered by main patches |
| `lane-b/N2-client-before-integration-rebase` | 2 / 1 | Archived at `codex/mac-migration-20261118/lane-b/N2-client-before-integration-rebase` |
| `lane-b/N2-pair-before-integration-rebase` | 2 / 1 | Archived at `codex/mac-migration-20261118/lane-b/N2-pair-before-integration-rebase` |
| `lane-b/P0-release-guards` | 1 / 0 | Covered by main patches |
| `lane-b/agent-registration-contract-review` | 1 / 0 | Covered by main patches |
| `lane-b/c-closed-native-bootstrap` | 8 / 8 | Archived at `codex/mac-migration-20261118/lane-b/c-closed-native-bootstrap` |
| `lane-b/c-completed-noaction` | 1 / 1 | Archived at `codex/mac-migration-20261118/lane-b/c-completed-noaction` |
| `lane-b/c-graph-approval` | 1 / 1 | Archived at `codex/mac-migration-20261118/lane-b/c-graph-approval` |
| `lane-b/c-openclaw-immutable-target` | 4 / 4 | Archived at `codex/mac-migration-20261118/lane-b/c-openclaw-immutable-target` |
| `lane-b/c-phase-c-parallel-receiver` | 5 / 5 | Archived at `codex/mac-migration-20261118/lane-b/c-phase-c-parallel-receiver` |
| `lane-b/c-trusted-control-integration` | 9 / 9 | Archived at `codex/mac-migration-20261118/lane-b/c-trusted-control-integration` |
| `lane-b/events-strict-before-b39` | 1 / 0 | Covered by main patches |
| `lane-b/windows-storage-consent-validation` | 2 / 2 | Archived at `codex/mac-migration-20261118/lane-b/windows-storage-consent-validation` |
| `pr178` | 5 / 1 | Archived at `codex/mac-migration-20261118/pr178` |
| `pr178b` | 7 / 2 | Archived at `codex/mac-migration-20261118/pr178b` |
| `pr75` | 2 / 0 | Covered by main patches |

The detached `owner-permission-verification` and `r2-journal-verification` branches are intermediate variants. Current owner-permission UI and the refreshed R2 journal fix have newer work in main/integration; these variants are references, not recommended replacements.

For a historical branch, `git show origin/codex/mac-migration-20261118/<source-label>` reads it without changing your checkout. inventory.json maps exact source SHAs to recovery refs and lists per-commit paths and patch equivalence.

## Excluded material and limits

- Generated web builds, temporary test output, private runtime/test-state files and bulk staged deletions from an abandoned rollback verification directory were excluded. Existing generated files inside historical commits remain part of those immutable commits; no generated file was edited or hand-merged for this packet.
- No `.env`, authentication files, live credentials, dependency installations, chat databases or chat transcripts were copied. Targeted known-key/private-key patterns found no matches in exported source patches or newly exposed commit diffs; this is a bounded scan, not a security certification.
- The initial Git census had 243 registered worktrees, including 26 missing directories. Missing directories cannot be inspected for uncommitted files; their registered HEAD commits and all local branches were included in the reachability review. This is a Git-worktree audit, not a search for every loose file on the Windows disk.
- Product source and all original worktrees were left unchanged. Snapshot restoration, commit reachability and remote ref verification are the validation for this archive. No live runtime, merge, deployment, CI-policy change or contract approval is implied.
- Read build-board issue #34 for current approvals. It records pending work-mode additions and an upstream dependency-audit blocker; old notes in this archive do not override it.

Keep the Windows data until the owner has verified the clone and any separately needed ignored configuration. Codex chat migration is optional and separate from this source recovery.
