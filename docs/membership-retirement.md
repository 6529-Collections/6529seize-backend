# Wave eligibility materialisation retirement

The experiment tracked by [#2075](https://github.com/6529-Collections/6529seize-backend/issues/2075)
is retired. [#2100](https://github.com/6529-Collections/6529seize-backend/pull/2100)
removed the application runtime. This combined follow-up removes its schema
metadata and infrastructure inventory, and provides an explicitly operated, environment-bound
cleanup. One PR covers monitoring, infrastructure and schema; their execution
order remains separate. Production retirement requires separate authorization.

## Supported application and schema behavior

Legacy eligibility coordination/cache from #2096, primary freshness and
invalidation, current-rule explicit-ID checks, authorization, group-member SQL,
transaction/snapshot/budget helpers and diagnostics remain supported. Nightly TDH,
xTDH universe then statistics, delegation and over-rate processing remain intact.
No OpenAPI, frontend, Help Bot, or ordinary product behavior changes are intended.

The eight membership entities, exports and application table constants are gone.
The three additive membership schema scopes and their compatibility guards are
removed. Scheduled dbMigrationsLoop maintenance still never synchronizes schema.
Manual full synchronization now works on a fresh database without membership
bootstrap; it ignores tables absent from the current entity registry. Historical
migration files remain unchanged. Normal deployment, full sync and migration
execution do **not** invoke destructive retirement DDL or recreate retired tables.

The `community_groups` generated column and
`idx_user_groups_pure_visible_id(is_pure_profile_group, visible, id)` remain:
`UserGroupsDb.searchByNameOrAuthor` uses the same visible/pure-profile predicates.
They support ordinary group search and are not owned exclusively by the retired
runtime. Every index owned by a dropped retired table disappears with that table.

The operator allowlist contains the eight generation/source/job/target/run/
publication/checkpoint/group-version tables and four superseded prototype tables:
`membership_materialization_states`, `membership_refresh_requests`,
`membership_watermarks`, and `user_group_members`. Git history identifies the
prototype tables as materialisation-only; they are not current application
entities. A table is removed only if present and included in the reviewed live
inventory and recoverable backup. Unexpected `membership_*` objects fail closed.
No database-wide drop or population backfill is part of this procedure.

## Prerequisites and recovery preparation

1. Confirm #2100 is on the development base and its application rollout has
   completed. Retain its deployment/artifact/health evidence and rollback limits.
   Audit every potentially affected deployed Lambda, including dormant bundles,
   aliases and non-catalog legacy functions. Verify artifact hashes, scan actual
   code for all retired table names and controls, and review reachable callers.
   A module's presence alone does not establish a caller. Deploy any independent
   old writer/reader before retirement. Never reuse another task's release record.
2. Verify replacement API, eligibility and producer health. Inspect all source
   controls, the actual disabled dispatcher schedule and worker event-source
   mapping. Wait for old invocation timeouts and queued/async deliveries to settle;
   inspect metrics, event destinations and all three queues. Do not run retired
   jobs or clear database backlog to make it look drained. Retain the 51 pending
   targets and five frozen GLOBAL job markers as evidence, if still present.
3. Resolve actual stack IDs and CloudFormation ownership, including resource
   policies, shared references, exports/importers and termination protection.
   Expected names are `membershipRefreshDispatcherLoop-staging` and
   `membershipRefreshLoop-staging`; names alone are not ownership evidence.
   Save describe-stacks, templates, resources, queue attributes, Lambda code ZIPs
   and hashes, function configuration, logs and historical failure-message bodies
   in private recovery storage. Receiving messages for evidence must not delete
   them. Preserve owned artifact buckets when needed for recovery.
4. Inventory schema objects, exact row counts/checksums, DDL, database identity,
   grants, foreign keys, views, routines, events and triggers. Verify visibility
   and external callers, not just an empty dependency query. Separately inspect
   the historical isolated fixture database; remove it only if its ownership and
   exclusive purpose are established and backed up. An absent or inaccessible
   fixture must be reported accurately, not silently included in a database drop.
5. Take a consistent logical backup of every selected table, including schema and
   data, and record SHA-256. Restore it to a disposable local MySQL database and
   compare definitions, row counts and checksums. Retain restore evidence and
   the exact pre-retirement inventory. Retain an available physical recovery
   point as additional protection; it does not replace the selective restore
   rehearsal. Protect backups as private application data, outside Git.

The rollback window closes only after application observation and recovery
rehearsal pass and immediately before this explicitly authorized retirement.
Do not treat time elapsed, an empty queue, or the older successful TDH cycle as a
substitute for fresh prerequisites.

## Staging execution order

Follow [deployment](deployment.md) and the [deployment skill](../ops/skills/deploy-6529/SKILL.md).
Complete PR/bot review and relevant CI. Create this change's Coordinator staging
record with `database_change=yes`, required backend units, and operational
`monitoring`. Preserve concurrent branch changes with an ordinary staging merge.

1. Deploy `dbMigrationsLoop` using the reviewed staging source through the normal
   workflow with `db_schema_scope=maintenance` and verify its artifact, live
   version and maintenance result. This explicit scope skips synchronization and
   historical migrations during code rollout; manual `full` remains available. Recheck retained table counts/checksums: the deployment must not
   remove or repopulate them. If the deployed-bundle audit finds other reachable
   callers, include their canonical services in this release before retirement.
   No blanket redeployment of unrelated shared-import bundles is needed.
2. Deploy operational monitoring for staging through `Deploy operational
   monitoring`, then update the source-account monitoring stack using its
   [operational runbook](../ops/docs/operations/isolated-operational-monitoring.md).
   Review change sets: only dedicated membership alarm/subscription resources,
   service/log allowlists and their dependency-chain links should be removed.
   Preserve unrelated monitoring, IAM, alert delivery and source artifact storage.
   Confirm both log subscriptions are absent **before** deleting log groups.
3. Delete the verified dispatcher stack explicitly and wait for DELETE_COMPLETE.
   Recheck every worker queue export for remaining importers. Only then delete
   the verified worker stack and wait for DELETE_COMPLETE. Respect retained
   resources and diagnose failed deletion; never force replacement of a stack or
   deletion of a shared resource. Verify functions, versions, mapping, schedule,
   permissions, dedicated roles, alarms, metric filters, queues/DLQs and logs.
   Report retained artifact buckets and any other retained resources explicitly.
4. Database cleanup is **last**. Use the operator-only CLI below. It requires an explicit
   environment and is not wired into any deployment or migration workflow.
   Inspect and approve the exact plan, fresh checksums, recovery evidence and
   operational prerequisites. It takes an advisory operation lock, caps metadata
   lock waiting, compares database/server identity and all selected data/DDL,
   rejects database dependencies, and drops the allowlisted tables in one MySQL 8
   atomic DDL statement. A failure or lost acknowledgement requires re-inventory;
   there is no automatic retry or implicit rollback.
5. Verify absence of selected tables, unchanged unrelated schema, API/DB/Redis
   health, supported eligibility/member/private-wave/proxy/posting/voting/admin/
   curation coverage and producer progress. Exercise the TDH-to-xTDH chain with
   runtime/version/log/queue checks. Complete the related staging E2E run green
   before declaring this task's Phase 3 complete. Stop before production.

## Explicit database command

Use the repository wrapper and a staging-only connection or staging SSM tunnel.
Populate `RETIRE_ENVIRONMENT=staging` and `RETIRE_DB_HOST`, `RETIRE_DB_PORT`,
`RETIRE_DB_USER`, `RETIRE_DB_PASSWORD`, `RETIRE_DB_DATABASE` from the approved
staging connection without putting passwords in arguments or logs.

```sh
./bin/6529 exec ts-node ops/scripts/retire-membership-schema.ts plan /private/path/plan.json
./bin/6529 exec ts-node ops/scripts/retire-membership-schema.ts execute /private/path/plan.json 'staging:DATABASE:retire-membership'
```

Replace DATABASE with the exact reviewed schema name. Plan creation refuses to
overwrite a file. Before execution, add `backup` with `path`, `sha256`,
`restoreEvidencePath`, `restoreEvidenceSha256`, and `prerequisites` containing
`applicationHealthy`, `allDeployedConsumersAudited`, `dispatcherDeleted`,
`workerDeleted`, `deliveriesSettled`, all true. These are operator attestations
backed by the private evidence record, not substitutes for checks. The CLI
verifies evidence-file digests and the unchanged live inventory. The restore
evidence JSON must contain `verified: true`, `backupSha256` and `tables` matching
the plan exactly, produced by comparing the disposable restored database. Never edit the
inventory to bypass unexpected drift. Review and back up new state instead.

## Recovery and future production phase

Use compatible known-good #2100-or-later legacy application artifacts; keep
materialisation controls/triggers disabled. Do not restore the retired schema
just to roll back an unrelated application change. If recovery requires those
tables, first restore the verified backup into an isolated schema, compare it,
then restore only the approved tables to the original database. Old metadata or
frozen materialised data is never authoritative eligibility data.

Infrastructure recovery uses the saved deployed CloudFormation templates and
artifact ZIPs/buckets, worker before dispatcher because of queue exports, with
mapping and schedule disabled. Restore monitoring only after log groups exist.
Recreating and activating the experiment requires a new design and authorization.

A future authorized Phase 4 must re-fetch and merge current main, re-inventory
production independently (including its database), take and rehearse production
backups, confirm production rollback prerequisites, and prepare a new production
operator plan using `RETIRE_ENVIRONMENT=prod` and the exact
`prod:DATABASE:retire-membership` confirmation. Reuse this release's Coordinator identity on promotion; supply
this PR's canonical service grouping and the final publication signal for the
autonomous release-note bot. Repeat dependency-aware service rollout, monitoring,
dispatcher, worker, then database ordering and fresh health checks. Never use the
staging manifest or recovery files against production. This task authorizes no
production database connection, deployment, or resource deletion.
