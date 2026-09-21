# Wave eligibility materialisation retirement

The experiment tracked by [#2075](https://github.com/6529-Collections/6529seize-backend/issues/2075)
is retired. Full staging backfill across roughly one million identities was too
slow for the current need. The deployed legacy coordination fix in
[#2096](https://github.com/6529-Collections/6529seize-backend/pull/2096) greatly
reduced duplicate computations and request latency for the much smaller active
population. Keep that implementation and investigate remaining bottlenecks
independently. This decision does not claim the deferred runtime drill or
materialised cutover succeeded. Git history retains the design and experiment.

## Supported behavior and retained compatibility

- All-wave eligibility uses the legacy result cache and coordinated computation.
  Explicit-ID eligibility evaluates current rules directly. Preserve primary
  freshness checks, profile/catalogue invalidation, authorization rules,
  parallel input reads and sampled catalogue/coordination diagnostics.
- Group-member SQL, previews, inclusion/exclusion, minimum-Level-zero semantics,
  REP searches, grant rules, private waves, containment and moderation are
  unchanged. OpenAPI and frontend behavior are unchanged, so no frontend or
  Help Bot knowledge update is required.
- Producers perform their authoritative writes without source-state barriers,
  refresh targets, catalogue version bookkeeping or materialisation jobs.
  TDH/xTDH still use the existing universe-then-stats completion flow, with one
  nightly completion trigger and partial consolidation triggers. The xTDH
  receiver accepts queued older messages containing `membership_cycle_id` and
  ignores that obsolete field; SNS message-group extraction remains supported.
- Transaction-bound repository reads/writes, serial batches on an existing
  connection, NFT-owner sync freshness checks, SQL deadlines and private SQL
  log redaction remain. `src/db/primary-transaction.ts` retains the primary
  snapshot/budget boundary and tests independently of the experiment.
- All eight membership entity definitions and exports, table constants,
  historical migrations, the candidate/runtime indexes and guarded additive
  schema scopes remain. Full synchronization still requires the controlled
  schema and rejects drift. No table, index or data removal is included; no
  schema migration is required for this cleanup.
- Worker/dispatcher deploy and build entries, API read/shadow controls, producer
  controls, evaluator/backfill/GC/fixture machinery and diagnostic carrier
  actions are removed. `customReplayLoop` returns to its unscheduled no-op.
  Obsolete API environment keys are removed on its next deployment.

## Later rollout — requires separate deployment authorization

This PR stops at review/CI. No live controls, stacks, queues or tables have been
changed by this work. Follow [the deployment runbook](deployment.md) and
[deployment skill](../ops/skills/deploy-6529/SKILL.md), including Coordinator
recording, exact artifact/runtime verification and autonomous release metadata.

1. **Before merging the cleanup into a deployment branch**, use the existing
   pre-cleanup deployment controls to set source tracking to `inactive` for all
   remaining staging producers. The 21 September inventory found tracking on
   `externalCollectionLiveTailingLoop`, `externalCollectionSnapshottingLoop`,
   `tdhLoop`, `xTdhLoop`, `delegationsLoop`, `nftOwnersLoop`,
   `xTdhGrantsReviewerLoop`, `overRatesRevocationLoop`, `helpBotReplyLoop` and
   `helpBotDailyActivityCreditLoop`. The last two functions share the
   `helpBotReplyLoop` deployment unit. Recheck the inventory at rollout time.
   Set the xTDH receiver inactive before TDH/delegation senders. Retain API
   `legacy`/`off`, and verify actual dispatcher schedule and worker SQS mapping
   are disabled; environment values alone do not prove trigger state. Wait for
   existing producer invocations and xTDH phase deliveries to settle normally.
   Do not flush the xTDH queue or discard legitimate work.
2. Record disabled controls, invocation counts, source-job/refresh-target/run
   state and queue/DLQ depths. An empty SQS queue does **not** prove an empty DB
   backlog. Frozen source barriers/targets can remain; the maintained reader
   does not consult them. Do not run a refresh or delete backlog to make this
   inventory appear empty. Keep the previous artifacts and deployed stack
   templates for rollback.
3. Merge and deploy the cleanup to staging, sequentially: `api`, `xTdhLoop`,
   `tdhLoop`, `delegationsLoop`, `externalCollectionSnapshottingLoop`,
   `externalCollectionLiveTailingLoop`, `nftOwnersLoop`,
   `xTdhGrantsReviewerLoop`, `overRatesRevocationLoop`, `helpBotReplyLoop`, then
   `customReplayLoop`. The receiver precedes changed TDH/delegation senders;
   the API precedes producers and removes the retired deployment catalog
   entries. Existing schema/API dependencies are already deployed and unchanged.
   Do not deploy `dbMigrationsLoop` or either retired runtime unit for this PR.
4. Verify each service's exact version and health; exercise group eligibility,
   member lists/previews, private waves/DMs, proxy identities, posting/voting,
   admin checks and curations. Verify real producer writes and TDH/xTDH progress,
   and that membership bookkeeping stops changing. Compare legacy coordination
   and catalogue latency/error metrics with the prior baseline. Run the related
   staging E2E coverage and report its status under current release policy.
5. Production is a separately authorized phase after staging validation. Repeat
   fresh control/backlog checks, merge to `main`, and deploy the same units in
   order with production release-note grouping and the final publication signal.
   Never author a release note manually.

The service list above covers the API, actual source writers with deployment
controls, xTDH receiver, and fixture carrier. Shared singleton import cycles put
eligibility modules in many additional Lambda bundles (including media,
notification and indexing services). Their supported inactive paths, SQL rules
and external contracts are unchanged; do not redeploy those unrelated services
solely because a module appears in an esbuild input list. Before retiring
infrastructure, audit *all* deployed environments for old active controls and
any independent writer/caller. Any newly found active consumer must be disabled
and included in that environment's sequential rollout before retirement.

## Later infrastructure retirement — explicit authorization required

The original templates and resolver are retained under
[`ops/retired/membership`](../ops/retired/membership/README.md) as resource
inventory. They are excluded from normal build/deployment selection. Removing
source files does not delete existing CloudFormation stacks. The separate
`ops/monitoring/retained-services.json` preserves the exact existing monitoring
resources, relay allowlists and subscription order; a routine monitoring
regeneration/deployment must not silently remove them.

After the application rollout and an agreed rollback window:

1. Reconfirm there are no callers/writers or in-flight worker/dispatcher
   invocations, and both triggers remain disabled. Inspect work, work-DLQ and
   dispatcher-failure queues and retain any evidence needed; inspect DB backlog
   separately. Do not purge or drop data as an incidental step.
2. Resolve the actual stacks from Lambda/SQS/EventBridge CloudFormation
   ownership in each account/region. Expected service names are
   `membershipRefreshDispatcherLoop-<stage>` and `membershipRefreshLoop-<stage>`;
   verify stack IDs, resources, exports and importers rather than assuming names.
   Save `aws cloudformation get-template`, `describe-stacks` and
   `list-stack-resources` results. Check termination protection, resource
   retention/deletion policies and log/evidence retention requirements.
3. In the separately reviewed infrastructure change, remove the two entries
   from the retained monitoring inventory and its insertion logic, regenerate
   monitoring templates, and inspect the change sets. Remove their log
   subscriptions/monitoring references before deleting their log groups. Keep
   unrelated monitoring and alert delivery intact.
4. Use explicit CloudFormation stack deletion for the verified **dispatcher
   first**, wait for `stack-delete-complete`, then verify no remaining imports
   of the worker's queue exports and delete the **worker** stack. The normal
   application deploy workflow cannot perform these deletions. Investigate a
   failed delete or unexpected resource instead of forcing or recreating stacks.
   Check Lambda, EventBridge, SQS/DLQs, IAM and monitoring cleanup afterward.
   Direct AWS CloudFormation operations use the deployed templates, so the
   archived Serverless source does not need to be packaged to retire a stack.
5. Keep database cleanup separate. Only a later explicitly authorized change may
   remove the eight tables, historical compatibility metadata or schema guards;
   inventory dependencies, take the required backups, and retain the rollback
   window first. The isolated staging fixture schema, if present, also needs its
   own owned-data inventory and approval. This PR does not erase it.

Rollback before infrastructure retirement uses a reviewed revert or the retained
known-good artifacts through ordinary deployment, with legacy/off and all source
tracking/runtime triggers inactive. Do not re-enable the experiment during a
rollback. After infrastructure retirement, application rollback must still use
legacy/off; reintroducing workers or trusting old materialised data would require
new design and activation work.
