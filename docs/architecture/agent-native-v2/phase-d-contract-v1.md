# Phase D contract v1 — execution record

Status: implementation in progress on `lane-b/phase-d`. No hosted acceptance or deployment claim.

## D0 — baseline and boundaries

The working base is `d05498d8dc13c6f07dc151da7a41a1619ff62436` (the reviewed remote-auth client PR #173, stacked on server PR #203). The current integration SHA at start was `97212c8d17ea3ddace008b6fd630a31f5e8f0d46`. Phase A/B/C human acceptance remains historical evidence; it does not certify this branch.

The new services are off unless their exact server flags are `true`. Relationship records cannot change exact-address message delivery or legacy contacts. A2A is an edge over persisted Envoi Cases and Assets; its transport records are not a second source of truth. No global agent directory or list endpoint is permitted.

## D1 — relationships and trusted discovery

A relationship is a directed grant from one active agent to another. Its owner is the granting inbox. `status` is `active` or `revoked`, and `grants` is a subset of `shareAssets`, `autoAcceptSelectedTasks`, `richerProfileVisibility`, `allowInvitations`. Only an authenticated administrator of the granting inbox can create or revoke it. A grant never implies its reverse direction. The target must resolve by an exact address to a verified agent that is active or paused. A block by either side prevents grant creation and hides existing trust at discovery time. The mutation checks both inboxes under locks.

Discovery inputs are one exact address, an approved contact, an active directed relationship, a signed invitation, or an authenticated same-organization context. The first implementation supports exact-address resolution and the caller's own approved contacts and relationships. It does not enumerate the directory or guess identifiers. Exact-address responses reveal no target when the target is not verified or is neither active nor paused. More permissive modes require a separate contract and review.

## D2 — authorization

`authorize({ actorAgentId, installationId, action, relationshipId?, caseId?, resourceId? }, facts)` returns an allow/deny decision with a stable reason. The evaluator checks, in order: active identity, active installation bound to that agent, action permission, relationship grant when required, Case membership, resource grant, policy, then human approval. Missing required facts deny. The caller must load fresh facts under the route's existing mutation lock and must not use an earlier authorization result after a state change. Initial adoption is limited to new V2 routes; existing gates stay in force until individually migrated.

## D3 — A2A edge

Target protocol: [A2A v1.0.1](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md). The first adapter will advertise only implemented operations. Agent Cards expose a per-agent public interface without private membership or secrets and declare bearer authentication. Incoming authenticated A2A messages become canonical Envoi work, with a persisted Case and event before any wake. Artifacts are references to authorized Envoi Assets. Polling returns a projection of the persisted Case. Unsupported streaming, push, and protocol methods fail explicitly and are not advertised. The current branch has parser and projection code but no HTTP edge yet; startup rejects `ENVOI_A2A_GATEWAY=true` until the edge exists.

The HTTP design must bind each card and task URL to one exact agent address. A global card would imply that Envoi is one agent and could encourage directory enumeration. The edge must authenticate the caller on every send and poll, reuse native message idempotency and Case membership, then read the committed Case for its A2A response. Card discovery needs an address-specific URL strategy before the gateway flag can be enabled; no hostname scheme is assumed by this contract.

## Gates

Unit tests cover invalid flags, grant validation, directionality, revocation, discovery non-enumeration, and ordered deny reasons. HTTP tests cover route authentication and feature-off behavior. A2A tests cover authentication, idempotent persistence, canonical Case projection, and no wake before persistence. Typecheck, test suite, and build must pass before a draft PR. Merge, flags, and deployment remain separate decisions.

## Current execution checkpoint

| Step | Done | Next work |
| --- | --- | --- |
| D0 | Baseline and contract recorded | Review against changes to integration when PR #203/#173 land |
| D1 | Directed relationship persistence, revocation, exact-address discovery, real HTTP tests | Signed invitation and same-organization discovery contracts; blocked-target recheck during all grant use |
| D2 | Ordered evaluator and use by agent discovery | Move Case and Asset V2 authorization to the shared evaluator under their existing locks; audit deny reasons |
| D3 | v1.0.1 text parser, Case projection, card projection | Authenticated REST edge, idempotent native send, canonical task polling, authorized Asset references, persistence-before-wake test |
