# Final competition storage and infrastructure cleanup

This procedure removes the completed transition machinery after the native
runtime retirement. It changes no public API, voting-credit rule, frontend
contract, help-bot behavior, media or CDN object. Use ordinary merges and the
existing deployment workflows, preserving concurrent developers' changes.

## Exact boundary

`src/competitions/retired-competition-storage.ts` is the physical allowlist:
21 former vote/decision/migration/mirror tables, plus five audited historical
vote copies (`dr_vote_backup_20250506`, `drv_vote_backup_20250506`,
`drop_real_vote_in_time_xxx`, `drop_voter_states_backup_20250506`,
`winner_drop_voter_votes_bckup_15_07_25_1`). Only objects actually present in the
reviewed inventory are dropped. The October 22 audit found 21 staging and 26
production tables, and 58 obsolete columns: 29 on `waves`, 28 on
`waves_archive`, and `competitions.storage_mode`.

Keep shared hub participation/voting policies and their typed decision strategy,
wave/chat/drop metadata, archival rows, native configuration/entries/votes,
independent AGGREGATE/VOTER histories, decision/award snapshots, locks, nonces,
command receipts, outboxes, claims and delivery/effect receipts. Keep the fourteen
permanent `legacy_get_*` views and immutable original-primary mapping. The native
decision and leaderboard Lambda units remain deployed.

The four targeted deleted-wave mappings are fixed in
`competition-storage-cleanup.ts`:

| Deleted wave                           | Obsolete competition                   |
| -------------------------------------- | -------------------------------------- |
| `2e156526-042d-4b6c-9691-17c0cdd0bb9d` | `0e2fc368-7a48-5bf4-ab5b-1738fa98e7fb` |
| `d6392f2d-3110-49ea-953b-110aa2096f35` | `92111347-0318-5c35-ad59-6f82a5417dab` |
| `fbb1ab73-cec6-4430-a120-c916d8324cee` | `9afbb5a9-9235-56e4-8aef-9c34153721f5` |
| `5a8f7453-c2f9-4d24-8d38-70b7eadd447e` | `f15f11c5-22c4-56c7-bc08-59c1572031ba` |

The refreshed production audit found 83 related rows. Delete only 39 obsolete
rows across competitions (4), config versions (5), dropper metrics (5), reader
metrics (21), old decisions (1), old decision winners (1), old voter snapshots
(1), and old NFT-credit archive (1). Retain the 44 shared history rows: profile
activity (26), deleted drops (13), wave archives (5). Counts are evidence, not
permission to accept a changed manifest. The fixed historical winning drop
`3e6067d1-51ff-4909-9e5f-28c69e486af4` has a 639246-vote snapshot; current
claim/card/native ownership must still be absent. The operator rejects mapping
changes, recreated waves, unexpected native references and protected ownership.

## Recovery and reviewed operations

Keep evidence outside the checkout and GitHub logs/artifacts: plans contain
private source records. Use owner-only directories/files. The operator performs
no entity synchronization, migrations, arbitrary SQL or automatic retry.

1. Capture the live inventory, environment, writer database/server UUID, exact
   inert-table DDL/counts/extended checksums, obsolete columns/affected indexes,
   shared-table DDL and targeted source rows. Record current deployment versions,
   timeouts, aliases, event routing and old-invocation drain evidence.
2. Create an encrypted, same-account/region RDS snapshot named
   `competition-retirement-<environment>-<suffix>`. Staging uses an instance
   snapshot; production uses an Aurora cluster snapshot. Wait for `available`.
3. Restore it into a separate private database named
   `competition-retirement-<environment>-restore-<suffix>` using the existing DB
   subnet/security groups and engine version. Do not point applications or
   queues at it, widen security groups, or make it public. Attach one temporary
   Aurora instance when restoring a production cluster.
4. Query the isolated restore using read-only credentials. Compare every
   affected source table's exact schema/count/checksum, every retired column and
   affected index, and every targeted source row. Record the restored server
   UUID, actual source snapshot ARN, encryption/status, reviewed deployment
   revision, verification time and SHA-256 of the drain evidence in `recovery.json`.
   `approval.ts` validates this evidence. A reviewed partial-DDL recovery can use
   the original snapshot only if it covers every remaining object/record.
5. Recheck the source plan immediately before mutation. A changed inventory,
   row count, ownership or checksum fails closed. Do not edit a digest or
   fabricate restore evidence to make a failed comparison pass.

Local access uses the normal approved AWS credential chain and a private DB
connection. Run from the root, through `bin/6529 exec ts-node -r
 tsconfig-paths/register`, with `RETIRE_ENVIRONMENT` and `RETIRE_DB_HOST`, `PORT`,
`USER`, `PASSWORD`, `DATABASE`. Invoke
`ops/scripts/competition-storage-retirement/cli.ts` as:

```text
plan PLAN.json
orphans PLAN.json RECOVERY.json ENVIRONMENT:DATABASE:PLAN_SHA256:orphans
prepare PLAN.json RECOVERY.json ENVIRONMENT:DATABASE:PLAN_SHA256:prepare
drop PLAN.json RECOVERY.json ENVIRONMENT:DATABASE:PLAN_SHA256:drop
```

Where direct private access is unavailable, bundle `lambda.ts` with the existing
root esbuild binary (`--bundle --platform=node --target=node22`) into an IAM-only,
task-owned temporary Lambda. Use the existing API VPC configuration/execution
role, no trigger, no public URL and explicit `RETIRE_ENVIRONMENT` /
`RETIRE_OPERATION`. `plan` uses `DB_USER_READ` against the writer endpoint;
`RETIRE_RESTORE_HOST` is allowed only for a named isolated restore and only in
plan mode. Isolated restore SELECTs have a bounded sixty-second limit for cold
snapshot reads; live SELECTs retain their ten-second limit. Mutation requires the independently reviewed `approved-plan.json`
and `recovery.json` packaged in the artifact, and the exact confirmation token
in the invocation. Verify the function artifact hash/configuration before
invocation. Never print the payload/plan or database credentials to public logs.
Delete the temporary functions/logs and isolated restore instances/clusters after
verification; retain encrypted recovery snapshots and private evidence.

## Rolling staging and production order

Complete local/PR review and relevant checks first. In each environment:

1. Merge into the latest authorized target branch. Deploy `dbMigrationsLoop`
   with `db_schema_scope=maintenance`. Verify the exact artifact/version/health.
   Drain invocations of its previous schema-capable revision using the old
   configured timeout (up to 900 seconds), aliases and routing evidence. Manual
   maintenance installs current native views without synchronizing entities.
2. **Before any worker with removed storage guards is deployed**, use the
   verified snapshot/restore and targeted `orphans` operation. The four old
   production records were ACTIVE/PUBLISHED legacy adapters; simply removing
   their storage predicate would otherwise expose them as executable native work.
   Re-plan and run `prepare` to set the retained selector's default to NATIVE.
   This keeps older overlapping readers compatible with new competition inserts.
3. Deploy affected consumers sequentially, waiting for each run's build,
   integrity, runtime-version and health checks. Determine the final service set
   from the changed call paths and `src/config/deploy-services.json`, including
   native claims, newsletter, curation, profile/delegation/TDH, notification and
   drop-producing consumers. The required core sequence is schema maintenance,
   claims/other downstream consumers, over-rate/delegation/TDH writers,
   leaderboard, decisions, and API. `helpBotReplyLoop` also verifies its daily
   activity-credit companion; it is not a separate deploy choice. Newsletter is
   production-only. Verify compatible unchanged dependencies instead of
   redeploying unrelated units. No frontend deployment is required.
4. Drain old readers/writers using their configured timeouts and routing. Verify
   native drafts/DISABLED controls, original and sibling reads, special
   capabilities, history/activity, claims/receipts and batched browsing/TDH work.
5. Take and independently verify a final snapshot after any changed retired
   default/schema. Review a fresh plan. Run explicit `drop`. Metadata-lock and
   InnoDB waits are five seconds; SELECTs have a ten-second server limit.
   Extended checksums scan only inert retired tables, not shared live tables;
   bound the operator invocation and inspect failure instead of retrying it.
   Index deletion requires `ALGORITHM=INPLACE, LOCK=NONE`; column deletion
   requires `ALGORITHM=INSTANT`. There is no COPY/locking fallback. Stop on an
   unsupported algorithm, unexpected view/program/FK or unreadable dependency.
   DDL commits independently: inspect partial results and re-review the
   remaining manifest against the original restored recovery snapshot.
6. Invoke ordinary `dbMigrationsLoop` full maintenance. It must pass its explicit
   guard, synchronize current entities and maintain all native views without
   recreating retired objects. Historical ledger entries are retained;
   already-applied data migrations do not rerun. Removed historical migrations
   targeted only obsolete storage; the mixed voting-index migration retains its
   shared drop index, and the card mapping migration uses the permanent view.
7. Retire dedicated infrastructure as below; verify native health and absence of
   old objects through repeated ordinary maintenance. Related staging E2E must
   be green before promotion for this release. Production E2E is reported
   separately. Keep autonomous release-note PR/service grouping, with the final
   publication signal only on the final successful production service run.

## Services for this cleanup

Deploy these units one at a time in this order. Skip production-only units in
staging. Repeat `dbMigrationsLoop` with full scope after intentional deletion;
its initial run uses maintenance. Verify the unchanged xTDH and artwork
processor dependencies through their existing catalog/runtime checks.

| Service                                   | Changed executed path                                     |
| ----------------------------------------- | --------------------------------------------------------- |
| `dbMigrationsLoop`                        | Guarded entity sync and permanent view maintenance        |
| `claimsBuilder`                           | Native decision/winner context and card mapping           |
| `newsletterLoop` (production)             | Native Main Stage winner reads                            |
| `pushNotificationsHandler`                | Badge eligibility uses the native group catalogue         |
| `dropMediaSanitizer`                      | Status broadcasts hydrate native profile/drop context     |
| `artCurationNftWatchLoop`                 | Native entry/configuration and confirmed transfers        |
| `overRatesRevocationLoop`                 | Native revocation discovery and accounting                |
| `delegationsLoop`                         | Profile merge and partial TDH reconciliation              |
| `tdhLoop`                                 | Main Stage totals and native overvote reconciliation      |
| `mintAnnouncementsLoop`                   | Shared drop update membership hooks and profile context   |
| `transactionsProcessingLoop`              | Subscription drop creation and native context             |
| `helpBotReplyLoop`                        | Drop/native context, including its daily-credit companion |
| `releaseDigestLoop` (production)          | Shared drop creation/profile context                      |
| `releaseNotesGenerationLoop` (production) | Shared drop creation/profile context                      |
| `waveLeaderboardSnapshotterLoop`          | Native discovery and history reads                        |
| `waveDecisionExecutionLoop`               | Native discovery, decisions and event context             |
| `api`                                     | Native commands, readers, navigation and group catalogue  |

Static import reachability alone overcounts consumers. Priority-alert-only
indexers use unchanged direct group/identity methods; documentation uses explicit
group IDs; xTDH creation/grant review uses unchanged identity/rate methods;
attachment/NFT-link notifications and delivery recovery do not call the changed
profile enrichment paths. Metrics refresh uses the unchanged permanent view
rewriter. These do not need deployment merely because they import a class or
the facade's schema-definition module.

## Retired infrastructure

Operate only on `competitionMigrationLoop-<environment>` in application account
`987989283142`, staging `eu-west-1` or production `us-east-1`. The monitoring
account is `876382073372` in `eu-west-1` for both environments.

1. Verify the retired function is the inert acknowledgement artifact, reserved
   concurrency is zero, queued events have expired (max age 60 seconds, retries
   zero), old 900-second invocations have drained, and no aliases, event source
   mappings, unexpected policy or external invokers remain. Save the code hash,
   configuration, live stack/resource inventory and dedicated logs privately.
2. Archive the dedicated log group to the existing private recovery bucket with
   encryption, verify the archive, and retain its code/template artifacts.
3. Run `monitoring-cli.ts` through the existing scoped monitoring workflow using
   `operation=retire-competition-registration`. Its fresh live template must
   change only the exact retired producer allowlist entries; no broad admin
   credentials or IAM trust expansion is needed. For source registration run
   the same CLI with `RETIRE_STACK_KIND=source` and the source-account identity.
   It removes the exact log subscription and Errors/Throttles alarms, reconnects
   the next subscription's dependency, and preserves every shared target.
4. Run the CLI with `RETIRE_STACK_KIND=migrator` to mark only the dedicated
   artifact bucket and its policy `Retain`. The strict nine-resource ownership
   guard rejects broader shared-role policies or unexpected resources. Review
   the full change set; require no additions, unrelated modifications or
   replacements. The CLI rechecks the live stack before execution and verifies
   the exact resulting original template afterward.
5. Delete that exact retired stack through CloudFormation. Verify deletion of
   the function, version, invocation configuration, dedicated continuation
   inline policy, two alarms and log group; retain the artifact bucket/policy.
   Never delete the shared `lambda-vpc-role`, shared monitoring stacks or native
   leaderboard/decision functions. Verify source subscriptions, monitoring
   health and generated coverage have no retired targets.

The CLI requires `AWS_CLI_PATH` outside the checkout, `AWS_REGION`,
`MONITORING_ENVIRONMENT`, `MONITORING_COMMIT_SHA`, the existing private
`MONITORING_ARTIFACT_BUCKET`, a fresh private `RETIRE_EVIDENCE_DIR`, and
`RETIRE_APPLY=true` only for the reviewed execution. Default mode creates a
validated proposal without executing it. Respect concurrent operations; never
cancel someone else's deployment or overwrite a moved shared ref.

After deletion, recover forward with compatible native code. For data repair,
restore the encrypted snapshot in isolation, compare exact affected rows/schema,
and selectively recover only the reviewed data; never replace the live database
or blindly restore old physical selectors, triggers, ledger or execution queues.
