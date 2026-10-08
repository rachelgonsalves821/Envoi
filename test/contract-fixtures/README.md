# Shared contract fixtures

Machine-readable cases for the contracts in
[`docs/architecture/agent-native-v2/handoffs.md`](../../docs/architecture/agent-native-v2/handoffs.md).
Lane A (server) writes these files. Lane B (connector, SDK, UI) consumes them
in its own test runners and reports `MISMATCH` on the build board instead of
editing them.

## Layout

```
test/contract-fixtures/
  index.json            registry of every published contract
  <contract-id>/        one directory per contract, e.g. a3-pause-auth/
    *.json              one fixture per case
```

## `index.json`

```json
{
  "version": 1,
  "contracts": [
    {
      "id": "a3-pause-auth",
      "version": 1,
      "status": "published",
      "handoff": "docs/architecture/agent-native-v2/handoffs.md#a3-pause-auth-v1",
      "dir": "a3-pause-auth",
      "schemas": "schemas.json",
      "fixtures": ["paused-claim.json"]
    }
  ]
}
```

- `version` is the registry format version. Bump it only when this file's
  shape changes.
- Each contract entry has its own `version`. A contract change that alters
  any fixture a client already consumes bumps that number and records the
  reason in `handoffs.md`.
- `status` is `published` or `approved`. Only the human's
  `CONTRACT-APPROVED` comment on the build board moves a contract to
  `approved`.
- `schemas` (optional) names a JSON Schema file in `dir`. Its
  `definitions` include `fixture` (the shape of every fixture file) and one
  definition per response or event body that fixtures name in
  `response.schema` or `event.schema`.
- `fixtures` lists file names relative to `dir`. Every listed file must
  exist and every JSON file in `dir` other than `schemas` must be listed.

## Rules

- One source of truth. Test runners load fixtures from this directory by
  path; nobody copies them elsewhere.
- Fixtures contain no real credentials. Token values are obvious
  placeholders.
- Never weaken or delete a fixture to make a test pass. Fix the server or
  publish a new contract version.
