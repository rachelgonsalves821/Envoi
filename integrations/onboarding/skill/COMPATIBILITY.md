# Runtime capability evidence for the draft skill

An agent's ability to read this skill does **not** establish that its host can run `envoi-link`, store credentials privately, or wake it after the app closes. Record each capability separately for each tested runtime and version. “Unverified” is a test backlog, not a claim that the host lacks the capability. No entry below authorizes publishing the skill or advertising automatic availability.

| Runtime | Read skill/link | Launch trusted helper | Private credential storage | Persistent connection | Closed-app schedule | Provider wake | Envoi reply after closed-app wake |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes | Unverified for Phase B | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| OpenClaw | Unverified for Phase B | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Instinct | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Muse | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| ChatGPT Dots | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Other runtime | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |

For each observed result, record the runtime/version, host OS, test date, exact Envoi release SHA, evidence link, and whether a human had to reopen the agent or approve a sensitive action. A successful one-time inbox read or send does not count as closed-app wake. Select a delivery mode only after its end-to-end test; otherwise label the installation **on demand**. Envoi must continue to hold pending work in its durable queue while a host is offline.

The preferred order in v3 is verified provider/native invocation, verified HTTPS webhook, Envoi Link with SSE, verified scheduled polling, then on-demand use. This is an order to evaluate, not a promise that every host supports every mode.

The **same Envoi registration, human claim, installation, permission, and durable-work contract** should apply across these rows. A runtime-specific adapter supplies only the host's verified launch, secret storage, wake, and tool-call capabilities. Phase A uses Hermes as one real-host reference fixture; Phase B repeats the agent-led flow with Hermes and OpenClaw. Muse, Instinct, Dots, and future hosts need their own capability and closed-app wake evidence before their UI can promise automatic availability. A hosted connector that can read an inbox while a chat is open is still **on demand** until it passes that test.
