/** Runtime guidance mirrors the current connector and provider-route documentation.
 * A visible platform card is not an assertion that its enrollment route is live. */
export const productAsset = (path: string) => `${import.meta.env.DEV ? '' : '/web'}${path}`;

export const agentCatalog = [
  {
    id: 'openclaw', name: 'OpenClaw', logo: productAsset('/agents/openclaw.svg'), route: 'Local helper',
    summary: 'Connect a running OpenClaw Gateway from its trusted host.',
    requirements: ['A Gateway that completes a normal agent turn', 'Terminal access to the Gateway host', 'Node.js 22 or newer'],
    instructions: 'Use the trusted envoi-link helper on the Gateway host. It checks the local configuration and authenticated Gateway turn before enrollment. Show the claim code to the owner, wait for approval, then confirm the owner, workspace, agent address and permissions locally. Keep the connector running to receive work.'
  },
  {
    id: 'hermes', name: 'Hermes', logo: productAsset('/agents/hermes.png'), route: 'Local helper',
    summary: 'Connect a configured Hermes profile through its local API Server.',
    requirements: ['A profile that completes a normal chat', 'Access to the Hermes host', 'Node.js 22 or newer'],
    instructions: 'Run the trusted helper on the selected Hermes profile. Preparation reuses its model-provider credentials and creates or reuses a separate local API Server key. Start or restart the Gateway through its host supervisor, claim and approve the agent in Envoi, then confirm the approval on the host. Start a new Hermes chat and check a real incoming message.'
  },
  {
    id: 'grok', name: 'Grok', logo: productAsset('/agents/grok.svg'), route: 'xAI API bridge',
    summary: 'Use the xAI API-backed bridge from a trusted runtime host.',
    requirements: ['A private XAI_API_KEY on the host', 'Terminal access to the host', 'Node.js 22 or newer'],
    instructions: 'Open Manage agents → Advanced · Quick Connect when that connection flow is available. Select Grok and prepare the official connector on the host with its private xAI API key. This bridge uses the xAI API; it does not connect an existing consumer Grok chat. The Envoi enrollment token never replaces the provider key.'
  },
  {
    id: 'muse', name: 'Muse', logo: productAsset('/agents/muse.svg'), route: 'Reviewed connector',
    summary: 'A reviewed Meta Connector Platform route is being prepared.',
    requirements: ['Meta review and approval', 'Private account authorization', 'Verified read, write and background behavior'],
    instructions: 'Envoi has not opened Muse onboarding. The selected route requires a reviewed Connector Platform submission and a real account test of permissions, message exchange and background delivery. Do not use the separate user-created Custom Connector path for this beta.'
  },
  {
    id: 'instinct', name: 'Instinct', logo: productAsset('/agents/instinct.ico'), route: 'Provider route in review',
    summary: 'A supported private API or delegated browser route is being evaluated.',
    requirements: ['Provider-supported authorization', 'Per-action approval behavior', 'Verified scheduled work and reply'],
    instructions: 'Envoi has not opened Instinct onboarding. A third-party MCP installation is not a selected route. The candidate is a privately authorized API or delegated browser session with scheduled work, subject to an exact-account test. No email fallback is selected.'
  },
  {
    id: 'dots', name: 'Dots', logo: productAsset('/agents/dots.svg'), route: 'Remote connection',
    summary: 'ChatGPT Dots discovery, consent and event delivery are being validated.',
    requirements: ['Owner-installed custom MCP plugin', 'OAuth consent on the supported Envoi route', 'Verified Events subscription and reply'],
    instructions: 'Dots connects through a custom MCP plugin with owner OAuth consent. This route will open after authenticated tool use, event delivery and replies have been verified on the released deployment. It does not use a local connector or a pasted enrollment token.'
  }
] as const;

export type AgentCatalogId = (typeof agentCatalog)[number]['id'];
