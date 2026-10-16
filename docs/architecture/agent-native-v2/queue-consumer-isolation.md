# Queue consumer isolation and attribution

This procedure addresses incompatible server consumers sharing the staging queue. It does not establish the historical cause of PAUSE-2, repair its original case, or constitute a hosted gate pass. It requires a database/hosting operator and the human's approval for live access changes, session termination and deployment.

## Before making live changes

Preserve the original messages, lease records, private evidence and failed gate result. Keep the disposable recipient paused. Do not requeue PAUSE-2. Privately identify the actual database host, port and database name for every staging and beta runtime, including forgotten checkouts, preview deployments and background services. A process's public URL does not prove its database destination.

The operator must first verify the destination independently. With that connection already supplied through the private `DATABASE_URL` environment, compute its opaque destination fingerprint without connecting:

```powershell
node scripts/queue-consumers.mjs fingerprint
```

The fingerprint covers the configured host, port and database, excluding username, password and query parameters. It does not establish which database is behind a proxy, prove a historical destination, or authenticate a consumer. Never paste connection strings into arguments, chat, logs or the board. Matching destinations with separate endpoints/aliases may have different fingerprints; compare the actual destinations privately as well.

Set `ENVOI_EXPECTED_DATABASE_FINGERPRINT` to the independently verified destination's fingerprint in the intended runtime. Once set, a mismatching or malformed pin refuses PostgreSQL startup before a pool is created. A pin with no `DATABASE_URL` refuses server startup. The pin is optional for compatibility; adding this code alone does not isolate an existing deployment. The Worker forwards this setting to its Container. Existing TLS validation remains required. URL routing overrides and URL-level TLS overrides are rejected; the supported URL supplies host/port/database directly.

## Read-only inventory

The operator can use an authorized inspector account, with verified TLS and a matching target pin:

```powershell
node scripts/queue-consumers.mjs inventory
```

This command opens a `READ ONLY` transaction, reads database sessions and currently processing queue leases, then rolls back and closes the connection. It performs no migration, claim, refresh, retry, requeue, cancellation, access change or session termination. An absent/mismatched pin refuses to connect. Failures print a static diagnostic rather than raw PostgreSQL errors.

The report publishes only the opaque target fingerprint, backend process IDs, recognized consumer release SHA/instance tags, safe worker IDs and lease counts. Unknown application names and worker IDs are labelled unattributed instead of echoed. Do not treat an unattributed connection as a proven old consumer; map it privately to its runtime or legitimate administrative purpose. Default database permissions may hide details; limited visibility is not an exhaustive inventory.

New API/delivery processes stamp `application_name` as `envoi:<full-release-sha>:<instance-tag>` (or `unknown` for an unstamped development run). Their structured private operator logs include:

- `envoi.queue_consumer.started`: worker ID, instance tag, full configured release SHA, opaque host tag, process ID, backend and opaque destination fingerprint.
- `claimed`, `settled` and `lease_lost`: the same identity plus allowlisted delivery/message/case IDs and state.
- `rejected`: the same identity and a private reason code for a missing recipient directory row, invalid directory status or directory/outbox inbox mismatch. The public error remains unchanged.

Correlate the original outbox `locked_by` worker ID with these entries, and correlate the instance tag with `pg_stat_activity`. Preserve this mapping with hosting-instance inventory and logs for at least the gate's evidence retention period; the opaque host tag alone does not reveal a hostname. These identities are self-reported attribution, not authorization or binary attestation. They cannot identify old processes retroactively, and the PostgreSQL connection list is only a point-in-time view.

## Operator containment and cutover

1. Establish whether beta and staging share a destination or role. Do not revoke a role or terminate connections that might serve beta before identifying its use. Confirm a rollback procedure that will not restore incompatible access to staging.
2. Provision a dedicated role restricted to the verified staging database and the permissions required by the application, including its startup migrations. Review inherited memberships and `PUBLIC` grants: merely creating another username does not isolate access. Supply the credential privately only to the approved staging deployment, with the verified target pin. Do not expose or change beta credentials as part of this task.
3. Have the human approve a coordinated maintenance/cutover window. Preserve evidence, freeze automatic staging deployment changes and quiesce the identified old consumers. Deploy one approved candidate with the new staging role. The hosting/database operator must exclude the old role's effective access to staging, including table/schema privileges and inherited grants, without affecting beta.
4. Terminate only verified legacy staging database sessions as part of the approved cutover. Password rotation, `NOLOGIN`, or revoking `CONNECT` alone does not end established sessions. Include any connection pool/proxy in the operator's inventory. Verify that retired clients cannot reconnect or operate against staging; do not infer success from a new `/health` response alone.
5. Confirm the approved candidate's `/health` SHA and `/ready`, privately inspect runtime destinations, and account for every queue consumer and remaining lease. Existing lease-owner tokens fence reclaimed work, but they do not enforce compatible code versions. This patch's target pin and identity logs cannot fence an already-running old binary; database access isolation is mandatory for the new gate.
6. Run all 23 hosted checks on the human-approved exact candidate and isolated database access configuration, using fresh disposable test cases. Leave the original failed PAUSE-2 case as evidence. Record whether failures or unknown consumers remain. The human must countersign `GATE GA PASS` before release; local tests and diagnostic probes cannot substitute.

Sources for the operator: [PostgreSQL CONNECT privileges](https://www.postgresql.org/docs/current/ddl-priv.html), [session signalling](https://www.postgresql.org/docs/current/functions-admin.html), and [pg_stat_activity](https://www.postgresql.org/docs/current/monitoring-stats.html).
