# Phase A closeout handoff - 2026-10-16

Candidate: `2b18170d59b0096ff997d9a79487d50ccb627ef9` on `integration/agent-native` (merged PR #95).
Status: human reports the earlier hosted-test issues corrected; Lane B closeout prepared. The integration CI rerun is blocked by image-registry availability. This handoff does not issue Lane A's authoritative gate result.

## Human confirmation and provenance

In the current Codex chat, the human stated that all 23 tests had been done, corrected the previous report with "these all were rectified and corrected" for the Run 3 limitations, and instructed "Lets close this and prepare for next implementation".
Treat those earlier limitations as corrected according to the human. Do not present the old failures as current defects or initiate another hosted run merely because the old board comments are stale.

The chat supplies the correction and direction to close out. It does not supply a new per-row audit ledger, runtime transcript, final test timestamps or bundle comparison. Lane A owns reconciliation of the completed run with the exact release and the authoritative evidence file; Lane B must not invent those observations or sign as the human.

## Verified automated evidence

| Evidence | Result |
| --- | --- |
| PR #95, bounded lease recovery and isolated prompts | Merged; candidate above |
| [Full CI on the candidate](https://github.com/rachelgonsalves821/Envoi/actions/runs/38969338867) | SUCCESS; backend 413 pass/15 skip, frontend 275, TS SDK 199, integrations 218 pass/1 skip, Python 6, PostgreSQL 46/46, scanner 14, Worker 11 |
| Build/generated consistency, production container, stress, Cloudflare checks and both audits in that run | PASS; audits reported zero vulnerabilities |
| [Integration run attempt 1](https://github.com/rachelgonsalves821/Envoi/actions/runs/38970607748/attempts/1) | Failed before checkout at PostgreSQL service-container pull |
| [Human-requested rerun, attempt 2](https://github.com/rachelgonsalves821/Envoi/actions/runs/38970607748/attempts/2) | Same pre-test failure: public.ecr.aws returned toomanyrequests: Data limit exceeded |

Attempt 2 reached no application test. It neither invalidates the successful same-SHA test results nor establishes a green integration check. No tests were weakened or skipped to address the registry outage.

## Lane A closeout request

1. Reconcile the human-confirmed completed/corrected hosted run with its actual release, connector hash and existing private server/connector records. Preserve historical failed runs as history.
2. Complete `docs/architecture/agent-native-v2/evidence/phase-a-<actual-sha>.md`, citing the existing sanitized observations. Do not create PASS rows from CI or mix releases.
3. Post Lane A's exact-SHA gate result and record the human countersign through the build-board protocol. The current chat is the human closeout input; do not impersonate a human-authored board comment.
4. Repair the CI registry dependency below and validate the workflow change on its own SHA. That infrastructure change is not evidence of a new hosted application run.
5. Once the gate record is reconciled, release the [Phase B implementation queue](../onboarding/PHASE-B-IMPLEMENTATION.md).

If the existing completed-run records reveal a real mismatch, report that precise mismatch. This handoff does not authorize new enrollment, messages, faults, deployments, setting changes, or changes to preserved test agents/cases.

## REQUEST lane-a: resilient PostgreSQL service startup

Owned file: `.github/workflows/ci.yml`. Its `jobs.test.services.postgres.image` is `public.ecr.aws/docker/library/postgres:16-alpine`. GitHub pulls services before steps, so retries inside later steps cannot recover this failure.

Requested implementation specification:
- Replace the pre-job PostgreSQL service with an explicit startup step before tests.
- Reuse the bounded mirror-then-Docker-Hub pull pattern already used for the production Node base image. Try the same official PostgreSQL 16 Alpine image through the mirror and Docker Hub; tag the successful pull consistently.
- Start one disposable container with the current test user/password/database and localhost port 5432; poll `pg_isready` with a bounded deadline, and fail if startup does not become healthy.
- Keep `DATABASE_URL`, the actual PostgreSQL test command, all assertions, and required checks intact.
- Use an always-run cleanup step for this container. Change no repository/registry settings and add no credentials.
- Validate both pull-source paths and exhausted-retry failure, then run full CI. Keep the workflow diff in Lane A's PR.

This is a request/specification, not a Lane B edit to a Lane A path. Existing anonymous limits may affect either registry; a bounded fallback must fail visibly if both are unavailable.

## References

- [Build rules](../../docs/architecture/agent-native-v2/claude-codex-build-plan.md), sections 2, 4-6.
- [23-row worksheet](PHASE-A-EVIDENCE-WORKSHEET.md).
- [Build board](https://github.com/rachelgonsalves821/Envoi/issues/34).
