# Lane B consuming review: `agent-registration` v1

**Publication:** PR #76 at `36f7943646f245ec1ac96bec706690fa370f3780`, `handoffs.md` § `agent-registration v1`, and the 68 canonical fixtures plus `schemas.json` in `test/contract-fixtures/agent-registration/`. This review is against that exact publication, not a server implementation or a deployed release. No fixture copy is committed in Lane B.

**Decision:** ACK for the route-neutral core contract. The client reconciliation is in draft PR #72. A-3.1b remote MCP/OAuth and provider authorization still need a separate publication and review. Live setup remains blocked on the A-4.x server, hosted Phase A gate, and route-specific acceptance.

The explicit consuming test `integrations/onboarding/test/agent-registration.review.mjs` reads the published fixture directory through `ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT`. Against all 68 fixtures it checks contract ID/version, the surface-specific code/lifecycle/retry/guidance mapping, the model-visible allowlist and absence of tokens/internal IDs. It directly feeds `routes-disabled`, `routes-available`, and `routes-available-rest` into the host planner, then checks the safe pending/approved/connected output examples against their canonical `client.modelVisible` projections. It also checks identical activation recovery, paused reattachment, code TTL, recovery TTL and permission labels. All three consuming tests passed.

| Contract question | Published result | Lane B treatment |
| --- | --- | --- |
| Wire states and codes | `handoffs.md` §§4, 8 and `schemas.json` `x-codes` | Helper output and review test use the exact surface mapping. |
| Meaning of connected | Authenticated `GET /api/agent/status` succeeds after activation | Activation alone does not claim connectivity; closed-app wake remains separate. |
| Code expiry and retry | 600-second claim window; show saved code again only on human request while pending | Claim URL contains no code; expired/rejected/withdrawn attempts never silently re-register. |
| Permission labels | `x-permission-labels` only | Examples match the canonical order and labels. |
| Public route publication | `GET /api/onboarding/routes`, not client-side flags | Draft manifest offers no routes; planner requires a validated availability response before selection. |
| Closed-app reachability | No `verified_closed_app` evidence in v1 | `envoi_link` is a declaration, not proof; unverified reachability remains explicit. |

**Additional reconciliation:** The local or trusted REST route may declare `envoi_link` when the server offers it. `poll` and `on_demand` are unavailable in v1 even if a host claims those capabilities. The planner will not select remote MCP/OAuth or provider connector from v1 availability. The draft `envoi-link` command still makes no network call and reports `liveEnrollmentAllowed: false`.

**Validation:** focused onboarding tests 25/25; published-fixture consuming review 3/3; TypeScript typecheck passed; integration suite 200 passed/1 existing skip outside the Windows sandbox after its temporary SSR-file ENOENT failure inside the sandbox; package dry run and `git diff --check` passed. PR #76's exact-head CI passed. These are contract-consumption and local checks, not hosted onboarding evidence.

**Approval order:** Board #34 contains a human `CONTRACT-APPROVED agent-registration v1` comment posted before Lane B's ACK. This review supplies the missing ACK evidence. The designated human should confirm that approval still applies to this exact SHA after reviewing this result before A-4.x implementation treats the contract as frozen.
