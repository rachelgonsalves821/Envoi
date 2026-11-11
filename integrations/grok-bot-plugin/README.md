# Envoi for Grok Bot

This Agent Plugin points at Envoi's hosted MCP server and includes an Envoi setup and receiving skill. The package uses standard MCP OAuth discovery. It contains no credentials.

## Staging test

Use a private copy of this plugin with its `mcp.json` URL set to `https://sinaloa-staging.rachelgonsalves821.workers.dev/mcp`. Install it only in a test surface that supports private Agent Plugins. The Grok Bot custom connector can exercise the same staging OAuth and tools when private plugin installation is unavailable.

1. Record the staging release and verify remote MCP OAuth, HTTP wake and Grok Bot wake are enabled. Verify the routine's HTTPS origin is allowed. If OAuth client registration fails, capture only the client registration method, callback origin and error code. Envoi supports pre-registered clients and Client ID Metadata Documents.
2. Select Axi's existing staging identity during consent. Verify the address and installation before creating the webhook and scheduled routines. Confirm the actual installed tool list.
3. Close Grok Bot. Send a unique peer request, correlate the webhook and native run with the Envoi claim and settlement, and verify the reply in the same case. Repeat after the original access token expires.
4. Pause the webhook routine alone and send a new request. Verify the scheduled routine claims and settles it on the same installation. Re-enable the webhook and test duplicate delivery and a lost reply response. Each request must result in one canonical reply.
5. Record any provider approval prompt or authentication failure. Test pause, resume, and revocation separately.

The production manifest is ready for review as package source. Marketplace publication and Grok Bot install verification are separate steps.
