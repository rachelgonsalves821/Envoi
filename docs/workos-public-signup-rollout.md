# WorkOS dual-admission beta rollout

**Status:** code candidate only. No staging or beta admission change, invitations, or hosted acceptance is recorded here.

## Policy and configuration

- The first beta admits up to **30 explicitly invited people** and **100 public accounts**. `ENVOI_BETA_INVITED_EMAILS` remains a nonempty, exact-email list for the invited cohort. Keep it aligned with the 30 approved waitlist addresses; a WorkOS invitation does not replace Envoi's allowlist.
- `ENVOI_HUMAN_SIGNUP_MODE` is `invite-only` by default. In that mode `/api/auth/config` reports `inviteOnly: true`, and unlisted accounts are denied even if WorkOS authenticates them.
- The explicit `public` mode requires `ENVOI_PUBLIC_SIGNUP_LIMIT=100` for this beta. It admits a verified WorkOS identity, reports `inviteOnly: false`, and displays **Create an account** in the app. The server serializes first public admissions in durable storage. A retry or later sign-in by a counted public user does not consume a second slot. Invited users do not consume public slots while their email remains on the list; a formerly invited user removed from the list must take a public slot to continue.
- The limit is an **account admission limit**, separate from request-rate, agent enrollment, Worker, Container, and database limits. Disabling public mode returns admission to the exact invite list; it does not delete public users or their workspaces. Reopening the mode uses the same durable ledger.
- Rachel selected **WorkOS MFA Off for this beta**, including the public cohort. Email verification, the WorkOS session, Envoi's admission checks, CSRF protection, and workspace authorization still apply. Record the actual WorkOS MFA and email-verification settings at the hosted gate; changing the intended policy requires a new review.
- Keep `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` off for this change. Human signup does not turn on agent installation routes.

## Hosted acceptance before enabling beta public traffic

1. Pin one candidate SHA, Worker version, Container image, staging database and backup. Confirm the paired Worker/image rollback and current restore evidence through the existing release packet and runbook. Stage A and agent onboarding gates remain independent.
2. On that candidate in **staging**, explicitly set public mode and a bounded staging limit. Confirm the WorkOS hosted sign-up path permits self-service creation and requires verified email. Record `/api/auth/config` with `inviteOnly: false` and the rendered **Create an account** link. Do not infer verification from the presence of a sign-up button.
3. With disposable, independent owners, complete a new public user's sign-up and an already invited user's sign-in. Verify each retains a stable local human ID, creates or opens a first workspace, signs out, and cannot read or mutate the other's workspace. Check stale sessions, CSRF and the 101st public account boundary with a controlled fixture or isolated staging database; do not create 101 real staging accounts merely to exercise the cap.
4. Confirm the beta WorkOS application settings, redirect/logout origins, email verification, and the selected **MFA Off** policy. Repeat the critical human admission and isolation checks on the exact beta release before opening public access. Record actual expected/observed results and sanitized evidence in the launch gate.
5. After the hosted beta gates and operator/product signoff, send WorkOS invitations to the approved waitlist addresses in small batches, verify acceptance, then enable `public` mode and `ENVOI_PUBLIC_SIGNUP_LIMIT=100` on the exact tested release. Recheck `/api/auth/config`, sign-in and sign-up. Changes to WorkOS or Cloudflare settings, invitations, merge, and deployment remain human release actions.

## Capacity, support and rollback

The supported cohort is at most **130 beta accounts**. No additional organic user should be promised admission after the 100 public slots fill. Product and operations should watch new accounts, workspace creation failures, request errors, database load and support volume during the first 24–48 hours. Support is scoped to the admitted cohort; pause public admission and return new visitors to the waitlist if the team cannot serve them. The beta does not promise a response time to people beyond this cohort.

To close admission, return `ENVOI_HUMAN_SIGNUP_MODE` to `invite-only` on a reviewed Worker/image release and verify `/api/auth/config` returns `inviteOnly: true`. Existing public data remains stored, but public users outside the invite list will lose application access until public mode is restored or they are explicitly invited. Record the rollback release, reason, and user communication plan before activation. A setting flip alone does not substitute for the paired Worker/image rollback rehearsal.
