# Envoi client cutover (N1-client)

Contract: approved `envoi-names v1`, build board #34. Base: `c352cec`.

The TypeScript package is `@envoi/protocol` and exports the `Envoi*` client types.
Python uses `envoi-protocol` / `envoi_protocol`. Runtime tools, prompts, relays,
service labels and download references use Envoi names only.

The default state directory is `…/envoi/<runtime>/<id>`. An existing installation's
directory moves once from the previous product directory. Its saved identity,
credentials, recovery state and work ledger are retained; it is never silently
enrolled again. After the coordinated credential cutover, owners explicitly
reconnect the same identity to replace retired credentials.

This PR must integrate with N1-server on one SHA. Lane A owns removal of duplicate
download packaging and canonical a3 v2 fixture publication. The client does not
provide old tool, package, class or credential aliases.

Migration locks the source and refuses an active connector or a destination
conflict. It retains the complete session and work directory, including pending
rotation recovery. Explicit custom directories stay as selected. Start/setup
accepting the prior canonical path move to the new canonical path once.
After a move, reinstall the Envoi service and retire its previous service entry;
service registration remains an explicit operator action.

N2 browser CSRF headers and cookies remain on their existing wire contract until
the separately coordinated browser/server rename. Historical gate evidence
also retains the names of the binaries it actually tested.
