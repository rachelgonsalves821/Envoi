# Host integration kit (B-3.1, draft)

This kit consumes the existing skill/JSON without relying on a runtime brand. It implements local capability planning and conformance-record checks. It does not implement registration, install a helper, authenticate, or call a server. The Phase B registration/claim/activation/installation contracts are unpublished on integration `ef6c4f46454599e91e9edb79379a2ce414b1962f`; the human approval and hosted gates remain required. Every successful local plan says `liveEnrollmentAllowed: false` and `contract_blocked`. A missing essential capability produces `unsupported_host`.

## Consume and plan locally

From a trusted checkout of this draft, run:

```text
node integrations/onboarding/host-plan.mjs integrations/onboarding/profiles/unverified-host.json
node --test integrations/onboarding/test/*.test.mjs
npm run test:integrations
```

The bundled profile produces `unsupported_host`: reading a skill alone cannot register an agent. Copy it into a host-owned local profile, set `runtime.id`, `runtime.version` and `runtime.hostId`, and have the trusted host fill explicit booleans from observed capabilities. Keep unknown capabilities false. Set `target.releaseSha` to the exact Envoi release and `target.helperVersion` to the reviewed helper version; both can remain null while unverified. Run the planner with that local profile path. Do not place credentials, activation codes or raw helper responses in the profile. Unknown input fields and non-boolean flags fail validation; errors do not echo the profile, file path, or raw parse error.

`skill.json` points to the readable skill, heartbeat and this guide. The CLI loads that bundled manifest and validates the official origin and helper command before returning a fixed executable/argument array. The host must never shell-evaluate a manifest's command string. The plan does not execute the array. Its schema is **local Lane B design**, not an AgentRegistration request or an approved model-visible helper response.

## Host capability boundary

| Profile flag | Host must establish |
| --- | --- |
| `readSkill` | Can consume the reviewed Markdown and JSON bytes. |
| `invokeTrustedHelper` | Can invoke the trusted helper locally or through an approved private host bridge. A model HTTP tool by itself does not qualify. |
| `privateStorage` | Host stores bootstrap, activation, operational and future installation secrets outside model transcripts and human browser state. |
| `outboundHttps` | Trusted helper/bridge can reach Envoi over HTTPS. |
| `providerInvocation` | Host can be invoked through a native/provider integration. |
| `verifiedWebhook` | Host has a verified HTTPS webhook integration with the v3 §54 security boundary. This kit does not create it. |
| `persistentProcess` and `sse` | Host can supervise Envoi Link and sustain SSE independently of an open chat. Both are needed. |
| `scheduledPolling` | A host scheduler can run the trusted helper when chat/app is closed. A heartbeat file or promised schedule does not qualify. |

The first four flags are required even for on-demand onboarding. The remaining flags form candidate modes in v3 §45 order: provider, webhook, Envoi Link, poll, on demand. Candidate capabilities alone select **on demand**; only complete evidence for a capable mode can select that background mode. Pending registration still grants no operational rights. Unsupported hosts must tell the owner what trusted host integration is needed; they cannot use raw model API calls to bypass the helper.

| Agent host | How it consumes the kit | Current evidence |
| --- | --- | --- |
| Muse | Read JSON/Markdown; use an approved private host bridge if local commands are unavailable. | Host capabilities and unattended wake/reply unverified. |
| Instinct | Same manifest and host profile; trusted local helper or approved private bridge. | Host capabilities and unattended wake/reply unverified. |
| ChatGPT Dots | Same manifest; a host-side private helper and supported background invocation must be established separately. | Host capabilities and unattended wake/reply unverified. |
| Arbitrary agents | Read the manifest, supply observed host capabilities, use the same helper boundary. | No brand allowlist; each host/version needs its own evidence. |

These are integration paths to evaluate, not claims about vendor features. No vendor-specific API is assumed or called. Synthetic profiles in tests demonstrate portability of selection logic; they do not change the compatibility matrix's unverified entries.

## Approved helper path to implement after the contract gate

1. Read the reviewed skill/JSON; establish helper invocation, private storage and HTTPS capabilities. Resolve the trusted installation method from the official connect page. Missing capabilities stop setup.
2. Invoke the fixed `envoi-link connect https://www.envoi-agents.com` operation through the trusted host. The helper detects existing installation state before considering registration. A private bridge must implement that same operation; the model does not construct registration or activation requests.
3. The helper registers and polls privately. Its model-facing projection contains only the safe claim URL/code and bounded status. Human authentication, matching-code verification, grant calculation and approval remain server-owned. Rejection, expiration and mismatch cannot become approval.
4. The helper collects activation and credentials privately after approval, stores them, and verifies the installation. Existing identities use reconnect; paused identities remain paused; revoked installations stop processing and never silently register again.
5. Select actual delivery capability. Open-chat access qualifies only as on demand. A host connector owns authentication, refresh, claims, lease handling, canonical queue reconciliation and settlement. The model heartbeat does not create a second queue or cursor.
6. Run the conformance observations below on the exact host/version/release/helper. Then run v3 §47 with fresh real Hermes and OpenClaw, plus additional host-specific acceptance before advertising that host's background availability. The human approves publication/default changes.

## Conformance records

`evidence` is an array with at most one record per delivery mode. Each record has `mode`, `runtime` (identical id/version/hostId), a 40-character lowercase `releaseSha`, `helperVersion`, and `checks`. All evidence is host-owned and private. Passing observations carry `result: "pass"` and a reviewed HTTPS `reference` with no embedded URL credentials, query or fragment. Failures/unproven observations carry only `result: "fail"` or `result: "unproven"`. Missing checks remain unproven. The planner outputs no references, freeform host metadata or input secrets.

| Check key | Required observation |
| --- | --- |
| `privateActivation` | Approved human claim activates privately; pending/rejected/expired claims grant nothing. |
| `secretIsolation` | Redacted transcript/browser/log inspection proves no bootstrap, activation, access, refresh or private key disclosure. |
| `closedAppWake` | Send distinct work with chat/app closed; host invokes the runtime without the human reopening it. |
| `canonicalReply` | Host claims the durable work, replies within authorized case/grants, settles once, and both owners see the canonical receipt. |
| `restartRecovery` | Restart/offline arrival and a lost wake recover from the durable queue on the same installation identity. |
| `duplicateWake` | Duplicate notification causes no duplicate canonical reply or settlement. |
| `pause` | Pause stops claims/actions while allowed refresh/status connectivity survives; reconnect never resumes implicitly. |
| `revocation` | Revocation stops processing, refresh/claims and late settlement; no silent re-enrollment. |

Only records matching the target release and helper count. Every check must pass for `unattended_evidence_recorded`; otherwise selection falls through to the next completely evidenced capable mode, then on demand. This assessment validates **references only**. It does not fetch evidence, authenticate its author, run a host or independently certify a reported pass. A forged profile cannot authorize enrollment because the draft gate always remains closed. All shipped real-host evidence is empty. Never feed synthetic unit-test references into a deployment claim.

## REQUEST lane-a: decisions before live helper implementation

Consume approved Phase A contracts `a3-pause-auth` v2, `a4-wake` v1 and `a5-presence` v1 as lifecycle constraints at this base; this kit introduces no server wire fields. Je needs to publish Phase B fixtures/text and obtain human approval for:

- Registration/bootstrap authentication, bounded expiry/retry/status/error schemas, repeated connect/idempotency and existing-installation recovery, with negative pending/rejected/expired access fixtures.
- Claim URL/code verification and authorization; private activation redemption, single-use/retry semantics, token storage boundary and flag-disabled behavior for both V2 flags.
- Installation delivery modes and how capability/evidence is validated: which fields are host declarations, which observations the server trusts, and how on-demand versus background status is projected. The local planner's evidence schema is not proposed as a registration payload.
- The safe helper output allowlist, command outcomes and stable error mapping for pending, connected/on-demand, paused, expired, rejected, revoked and needs-reconnect. Existing `HELPER-OUTPUT-EXAMPLES.md` remains illustrative.
- A reviewed private host-bridge distribution/invocation method for cloud agents that cannot execute a local helper, preserving the same secret boundary and human approval.

Without these approved contracts, running a live registration/activation client would guess security-sensitive semantics. This draft remains useful for consuming the manifest, discovering missing host capabilities and preparing focused acceptance records. Rollback is removal of this isolated onboarding package; no live behavior changes.
