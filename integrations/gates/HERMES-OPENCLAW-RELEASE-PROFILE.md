# Reviewed Hermes/OpenClaw release profile

This is source preparation. No deployment, flag change, key rotation or provider operation is implied by a green check.

Use an explicitly reviewed named profile with `scripts/promote-release.mjs` for the core-only staging/Production cutover. The default `cf:deploy:*` commands retain their separate defaults and are not this cutover command.

```powershell
node scripts/promote-release.mjs staging FULL_40_HEX_SHA --profile=hermes-openclaw
node scripts/promote-release.mjs beta FULL_40_HEX_SHA --profile=hermes-openclaw-preserve-monad
```

These are dry runs. Only a separate human approval of the exact SHA, artifact, targets, traffic plan and rollback permits adding `--deploy`. The source must be clean, descend from fetched main, and match main exactly for live promotion. Both targets keep their existing account, Worker and namespace checks.

The core-only `hermes-openclaw` profile serializes every onboarding flag: installation, agent registration and CaseSession ON; all other nine OFF. It explicitly sets `ENVOI_MONAD_PERMISSIONS=false`. It accepts no arbitrary flag overrides or unknown profile names. This prevents retained dashboard variables from silently selecting a broader profile.

The explicit disabled-Monad profile omits only the unused Monad issuer-secret requirement. All existing app/scanner encrypted secret names, retired-alias checks and identity guards remain. Default beta promotion still requires the issuer secret and retains its separate matching-key rollout gate. This profile never reads, rotates, deletes or replaces a key.

A release candidate must preserve both current main and agent-native integration histories. Do not force-push main or substitute one branch for the other. Pin the final reviewed source and image together. Confirm main/integration have not advanced before promotion.

Before any approved rollout: capture fresh Worker/image/config rollback pins and owner/workspace identity anchors; verify secret names and exact profile; confirm Builds remains paused; coordinate the staging window with any separate Dots acceptance work. Reuse a single immutable image for staging and Production. No scanner change is included.

After the corrected server is deployed, run Hermes and OpenClaw sequentially: activation with normal owner and host approval; canonical exchange/settlement and replay; same-identity reconnect; restart including changed Hermes loopback port; pause/resume, revoke and scope isolation. Local/synthetic tests do not count as these live passes. Keep tester admission held until the applicable hosted rows and human acceptance are complete.


## Preserve the current live Monad capability

Production changed separately to e25e528 with onboarding OFF and Monad ON during this preparation. The selected future beta command above therefore uses `hermes-openclaw-preserve-monad`: exactly the same three core onboarding flags ON and other nine OFF, retaining `ENVOI_MONAD_PERMISSIONS=true`. It requires the existing encrypted issuer secret; it never copies or rotates it. No manual RPC, transaction or provider acceptance test is included.

The preservation profile is beta only. Both the pure plan and CLI reject it on staging before source/secret access. Staging uses `hermes-openclaw` with Monad OFF, preserving its current capability and requiring no new issuer credential. The same immutable code image can be used, but staging core acceptance is not proof of beta Monad/provider/transaction acceptance. The beta off profile remains an explicit alternative only if separately approved; it must not silently replace the selected preservation profile.
