# Dots current-main release composition

Release base: current `origin/main` at `3237c13caf02f06ed8b1ffdfcdc1949a353fa730`.

This release carries selected onboarding source from #289 at `afc76d877a1154df47dc758c6204af937547a273`, plus the human-approved message-access recovery extension from #291 at `4a775ceec9b447c7a8cfba4102956e309ba4fdfc`. It does not promote the integration branch as a whole.

- Preserve main's owner connection callbacks, generic permissions editor and Phase D controls. Add recovery after `OAUTH_RECONSENT_REQUIRED` without bypassing the OAuth grant.
- Keep main's existing local-runtime prompts and reconnect picker. Deduplicate the picker already shipped through #287.
- Add the official-plugin Dots guide, `/connect?platform=dots`, scope/identity verification, same-identity recovery and copyable setup/message-access prompts. The MCP endpoint is a diagnostic address, not an installation page.
- Add the bounded `agent-remote-auth-message-access v1` server action and its fixtures under the human's explicit server-work exception and contract approval. It returns native OAuth recovery metadata for Receive+Send, checks current identity and policy, and does not grant access or send anything. Existing forbidden-call responses remain unchanged.
- Build generated `web/**` only with `npm run build` on this exact composition. Do not copy integration-generated output or reapply overlapping #259/#286/#289 source after this candidate.

The current personal production plugin keeps its App binding, connection configuration and audience. Its onboarding skill update is prepared separately for the same plugin identity. Public publishing is deferred. Rachel's access to that plugin, each owner's broader OAuth approval, and a real Onion/Delta exchange must be verified separately; local tests and CI are not hosted acceptance.

## Read-only recovery revision2 follow-up

This increment is based on live main `2d33991c289d7746a8ef7117c92eadda0ab651fc` and carries the approved revision2 source from `c7820823aba046c5f7e181164f2e8739c3e2357a`. The recovery action's declared prerequisite becomes `envoi.agent` alone so a receive-only connection covers it. Its returned owner-consent challenge remains `envoi.agent envoi.send`; actual Send enforcement, tool filtering, identity/policy gates and forbidden responses are unchanged. The host visibility explanation remains an inference until a real Dot invokes the corrected action.

The guide, prompt and official skill no longer require a fresh Dot chat. They keep the existing conversation, describe explicit plugin selection when available, and report a host tool-catalogue mismatch rather than treating an app settings list as proof the Dot can invoke it. Existing main controls are retained. Generated web was rebuilt from this exact production composition. No production release of this increment is implied by the source commit.
