# Gate B-local runbook: real Hermes and OpenClaw against a local Envoi server

**Purpose.** This runbook proves the agent-registration v1 local-helper journey with **real** Hermes and OpenClaw runtimes. The two runtimes and the Envoi server all run on one machine. It follows v3 §47 rows 1–17 and the two-owner plan's Phase B gate items.

**Authority.** The human chose a local server, with `ENVOI_INSTALLATIONS_V2` and `ENVOI_AGENT_REGISTRATION_V2` on, on 2026-10-17. The first attempt, at `984051f`, ran preflight only: its Hermes profile already held an Envoi connection, so no row was run. On 2026-10-19 the human chose to rerun the gate on integration `f3a71f6`, the integrated Phase C candidate, with the Phase C flags off.
- Every flag on staging and beta stays off.
- Nothing is deployed, and the helper is not published.
- Messages are sent only between the two local test agents, and only when the human operator sends or approves each one.

**What this does not prove.** v3 §47 asks for hosted runtimes. A pass here is a **local-server** Gate B-local and is recorded as such. It does not replace a hosted Phase B gate, the §47 breadth gate, or closed-app reachability.

Record everything in a copy of [`evidence/phase-b-local-TEMPLATE.md`](evidence/phase-b-local-TEMPLATE.md).

## 0. Roles

| Role | Who | Does |
| --- | --- | --- |
| Operator | the human | Runs the hosts, the browser and every message, and countersigns |
| Lane A | Claude | Starts and checks the server, saves views on request and builds the server evidence table with `scripts/ga-evidence.mjs` |
| Lane B | Codex | Supplies the helper build, records host and connector observations, and uses the [Lane B worksheet](../../../integrations/onboarding/skill/BREADTH-EVIDENCE.md) where it applies |

## 1. Prepare: one exact SHA, fresh state

1. **Check out `integration/agent-native` at the gate SHA**, with a clean tree.
   - Record the SHA in the evidence header.
   - Run `npm ci` and `npm run build`. `git status` must stay clean.
   - The build produces the private helper at `integrations/onboarding/dist/envoi-link.mjs`.
2. **Make a private directory outside the repository**, for example `%USERPROFILE%\envoi-gate-b-local`. It holds the TLS files and the server data. Never commit or publish anything from it.
3. **Generate a localhost certificate.** On Windows, use Git's OpenSSL:

   ```powershell
   $dir = "$env:USERPROFILE\envoi-gate-b-local"; New-Item -ItemType Directory -Force $dir | Out-Null
   $env:MSYS_NO_PATHCONV = '1'
   & 'C:\Program Files\Git\usr\bin\openssl.exe' req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout "$dir\localhost-key.pem" -out "$dir\localhost.pem"
   ```

   The helper accepts only an `https:` origin, as in production. The certificate gives it a real TLS origin on loopback.
4. **Prepare fresh runtimes.**
   - Use Hermes and OpenClaw profiles with no existing Envoi configuration or connector state (§47 row 1).
   - Record each version, the OS and the model provider, by name only.
   - Set `NODE_EXTRA_CA_CERTS=<dir>\localhost.pem` in the environment of every process that runs the helper or the connector. Do not disable TLS verification.
5. **Hermes: a disposable profile, never the regular one.** A profile that has ever held an Envoi or Sinaloa MCP entry is not fresh, even after the entry is removed. Follow the disposable-profile steps in [`integrations/gates/PHASE-A-HOSTED-RUNBOOK.md`](../../../integrations/gates/PHASE-A-HOSTED-RUNBOOK.md):
   - Install Hermes again with the official installer's `-HermesHome <abs-dir>` and `-InstallDir <abs-dir>\bin`, into an empty directory outside the repository. Do not repair or update the regular `%LOCALAPPDATA%\hermes` installation.
   - In every terminal for this runtime, set `$env:HERMES_HOME = '<abs-dir>'` first, and call the CLI by its absolute path, `<abs-dir>\bin\hermes.exe`. Never use the machine-wide `hermes`.
   - Give the disposable profile its own `API_SERVER_PORT` in its private `.env`, so it never collides with the regular Gateway.
   - Configure its model provider through Hermes' own setup, then prove one ordinary model turn with `integrations/gates/prepare-disposable-hermes.ps1 -Action ModelTurn`. The human enters every credential; the operator records the provider name only.
   - Check the startup banner: it must list no MCP server.

   **Accepted alternative: a new named profile in the existing installation.** Hermes v0.21 supports profiles, and the helper honours a `HERMES_HOME` that points straight at a profile directory.
   - Create the profile without `--clone`, so nothing is copied from the default profile: `hermes.exe profile create <name> --no-alias`.
   - Set `$env:HERMES_HOME = "$env:LOCALAPPDATA\hermes\profiles\<name>"` in every terminal for this runtime.
   - Run Hermes as `hermes.exe -p <name>`.
   - Configure its model with `hermes.exe -p <name> setup model`, and prove one ordinary model turn by hand. `prepare-disposable-hermes.ps1` requires a separate installation, so it does not apply here.
   - Lane A confirms that the profile's `config.yaml` has no `mcp_servers` section and that neither it nor `.env` mentions Envoi or Sinaloa.
   - Do not apply a Hermes update during the gate.
6. **OpenClaw: a profile no earlier Envoi connection ever touched.** Install OpenClaw from its official instructions, using Node 24.16 or newer. A per-window portable Node and npm prefix keep the install out of the machine-wide PATH.
   - **One profile for both readers.** The helper and OpenClaw must read the same `openclaw.json`.
     - OpenClaw 2026.10.5 kept its configuration in the default `%USERPROFILE%\.openclaw` even with `OPENCLAW_PROFILE` set.
     - The helper does honour `OPENCLAW_PROFILE`.
     - So on a machine that had no OpenClaw before the gate, use the default profile as the fresh gate profile, and leave `OPENCLAW_PROFILE` unset in every window.
     - On a machine with an existing OpenClaw profile, set `OPENCLAW_CONFIG_PATH` to the gate profile's `openclaw.json`, for both OpenClaw and the helper.
   - Run OpenClaw's own onboarding in that profile, with a model provider the human configures.
   - Set `gateway.auth.mode` to `token`, and keep the Gateway on loopback.
   - Prove one ordinary agent turn before the gate.
   - Its configuration must list no MCP server.
7. **Leave no earlier Envoi state for this origin.**
   - These must not exist: `%LOCALAPPDATA%\envoi\onboarding\<runtime>\<id>`, the helper state for `https://localhost:8443`, and `%LOCALAPPDATA%\envoi\<runtime>\<id>`, the connector state. Move any earlier copy aside before the run; never reuse it.
   - Leave connector state for other origins, such as an existing hosted Envoi connection, untouched.
8. **Run each agent from an empty working directory** outside the repository, such as `<dir>\agent-workdir`, and invoke the helper by its absolute path in the gate checkout. A run started inside a repository checkout can pick up a different connector build.

## 2. Start the local server and HTTPS front end

Run the server in its own terminal:

```powershell
$dir = "$env:USERPROFILE\envoi-gate-b-local"
$env:DATABASE_URL = ''; $env:ENVOI_AUTH_MODE = 'development'; $env:ENVOI_PORT = '8787'
$env:ENVOI_DATA_DIR = "$dir\data"
$env:ENVOI_INSTALLATIONS_V2 = 'true'; $env:ENVOI_AGENT_REGISTRATION_V2 = 'true'
Remove-Item Env:ENVOI_AUTHENTICATED_REST_ROUTE, Env:ENVOI_CASE_SESSIONS_V1, Env:ENVOI_HTTP_WAKE_V1 -ErrorAction SilentlyContinue
$env:ENVOI_PUBLIC_URL = 'https://localhost:8443'; $env:ENVOI_CORS_ORIGIN = 'https://localhost:8443'
$env:ENVOI_RELEASE_SHA = git rev-parse HEAD
npm start
```

`ENVOI_RELEASE_SHA` makes `/health` report the gate SHA, which the preflight and the stop conditions compare. Without it, `/health` reports `null`. The Phase C flags stay off: this gate proves Phase B onboarding only.

Then start the HTTPS front end in a second terminal:

```powershell
node scripts/local-https-proxy.mjs --cert "$env:USERPROFILE\envoi-gate-b-local\localhost.pem" --key "$env:USERPROFILE\envoi-gate-b-local\localhost-key.pem" --listen 8443 --target http://127.0.0.1:8787
```

**Notes**
- Leave `ENVOI_AUTHENTICATED_REST_ROUTE` unset.
- Use a fresh `ENVOI_DATA_DIR` for each attempt: the creation limits are durable.
- Every request arrives from 127.0.0.1, so one source carries all registrations, at 10 per hour.

**Preflight**, recorded in the header:
- `GET https://localhost:8443/health` shows the gate SHA as `releaseSha`.
- `GET /api/onboarding/routes` offers exactly `local_helper` and `envoi_link`.
- `GET /connect/skill.json` lists the same in `offeredConnectionRoutes` and `offeredDeliveryModes`.
- `GET /connect/SKILL.md` matches `integrations/onboarding/skill/SKILL.md` byte for byte.

## 3. Owner setup

1. Open `https://localhost:8443` in a browser and accept or trust the local certificate.
2. Sign in through the development phone and TOTP flow, which creates an MFA-verified local human.
3. Create one workspace for the gate.

In development, `approverEmailHint` is the fixed `d***@development.invalid`, because local-auth humans have no email. Record it as such. The masked-email confirmation itself is proven only in production.

**Known issue.** An authenticator code of the wrong length returns `500` instead of `400` in local development sign-in. This is an open Lane A bug, not a gate row. Enter the current six-digit code again.

## 4. Run the rows

Follow the template's rows in order.
- **Ask before each message.** The operator says each message aloud before it is sent: sender, recipient, purpose and expected reply.
- **Pause at each checkpoint.** At every row marked **S**, the operator saves the owner views listed in §5.

**Hermes, rows 1–10**
- The human asks Hermes, in its own chat, to connect itself to `https://localhost:8443`.
- Hermes reads `/connect` and `/connect/SKILL.md`, and runs `node <repo>/integrations/onboarding/dist/envoi-link.mjs connect https://localhost:8443 --runtime hermes`.
- The model transcript may contain only the claim URL, the code and safe status (row 6).
- The owner types the code at `https://localhost:8443/claim`, picks the workspace, a new agent name and address, and permissions, and approves.
- Hermes runs `envoi-link resume https://localhost:8443 --runtime hermes`. The host-native prompt shows the approver hint, workspace, agent and permissions. The human confirms there, not through the model.
- The connector must stay in the foreground. It must report connected only after an authenticated status check.

**OpenClaw.** Repeat the same flow with `--runtime openclaw`, as a second new agent.
- Start the OpenClaw Gateway (`openclaw gateway`) from a window that has the gate environment, including `NODE_EXTRA_CA_CERTS`. The agent's tool runs inherit that environment.
- The agent may run `connect` itself.
- The human runs `resume` in an interactive terminal. Without an interactive prompt, the helper stays at the confirmation step. That window then keeps the connector in the foreground.

**Rows 11–17**
- Hermes sends OpenClaw a message, and OpenClaw replies.
- Restart OpenClaw: stop its connector and runtime, then start them again with the same state directory.
- Send new work while it is down, then confirm it recovers that work exactly once.
- The owner revokes OpenClaw's installation from the installations view.
- Further processing must stop. The connector must end with `REVOKED` and must not re-enroll.

**Rows 18–20.** These cover the rest of the two-owner gate.
- The owner attaches a **new** registration to the revoked agent (`existing_agent`). The address and history must be unchanged.
- The UI and `GET …/installations` must agree on every installation's state.

## 5. Server evidence, captured privately

**Saving views.** The operator saves these JSON views from the signed-in browser to `<dir>\views\`, never to the repository. These are the agent inbox views:
- `/api/inboxes/{agentInboxId}/events/delta?limit=200` (follow `cursor`);
- `/api/inboxes/{agentInboxId}/agents`;
- `/api/inboxes/{agentInboxId}/agents/{agentId}/installations`;
- `/api/inboxes/{agentInboxId}/delivery-receipts`;
- `/api/inboxes/{agentInboxId}/deliveries`.

Save `/api/agent-claims` once per approval.

**Publishing the sanitized tables.** Only Lane A's sanitized output goes into the evidence file:

```powershell
node scripts/ga-evidence.mjs events <dir>\views\delta-row10.json --since <run start UTC>
node scripts/ga-evidence.mjs installations <dir>\views\installations-row17.json
node scripts/ga-evidence.mjs claims <dir>\views\claims-row7.json
node scripts/ga-evidence.mjs agents <dir>\views\agents-row17.json
node scripts/ga-evidence.mjs receipts <dir>\views\receipts-row15.json --since <run start UTC>
```

**What the extractor refuses.** It keeps allow-listed ids, enumerated values and times. It refuses anything that looks like a credential. Never save or publish `/messages`, `agent-view`, helper state, `session.json`, or transcripts that hold message text.

## 6. Stop conditions

Stop, record the row as FAIL or UNPROVEN, and post `BLOCKED` on board #34 when any of these happens:
- a credential, bootstrap token or `activationId` reaches a model transcript or log;
- the helper activates without the human's local confirmation;
- an agent is registered twice for one attempt;
- the SHA, `/health` or the routes change during the run;
- any request goes to a hosted Envoi origin.

A failed row means a fix, a new SHA and a rerun of **every** row (L5).

## 7. Close

1. Stop both connectors, the proxy and the server.
2. Keep `<dir>` private until the record is countersigned, then delete it. The data directory holds local test credentials.
3. Lane A publishes the evidence file at `evidence/phase-b-local-<sha>.md` and posts `GATE B-local PASS/FAIL @<sha>` on #34.
4. The human countersigns.
