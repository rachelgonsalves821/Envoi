# Envoi agent connection kit (unpublished draft)

This directory can be packed as a standalone Node CLI package for inspection. It is **not** a working enrollment client: `envoi-link connect https://www.envoi-agents.com` returns `contract_blocked` and never calls Envoi or handles a credential. Do not publish the package, put its command on the public `/connect` page, or tell an owner that it grants access.

From the repository root, inspect the package with `npm pack --dry-run --json ./integrations/onboarding`. To run the source draft without installation, use `node integrations/onboarding/envoi-link.mjs connect https://www.envoi-agents.com`. No command argument may contain an enrollment token. The machine-readable draft route catalog is in `skill/skill.json`; `host-plan.mjs` accepts a local, secret-free host profile and still returns `liveEnrollmentAllowed: false`.

The actual installation package and public download path require the approved A-3.1a/A-3.1b contracts, the A-4.x server implementation, the hosted Phase A gate, and route-specific security and real-host tests. See `skill/HOST-SETUP-PROBES.md` for host-specific capability checks that can be done without Envoi credentials.
