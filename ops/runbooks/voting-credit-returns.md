# Voting credit return notification rollout

Release capture is additive and does not change credit accounting. There is no
historical notification backfill. Author deletion applies only to permanent user
deletions of active entries, excluding admin/system cleanup and edit replacement.

Deploy sequentially using the ordinary deployment workflow:

Before the new worker deployment, an administrative identity must install the
matching `ops/iam/backend-{staging,production}/VotingCreditReturnDeployment.json`
as the `VotingCreditReturnDeployment` inline policy on that environment's
existing GitHub deployment role. Validate it with Access Analyzer and simulate
the worker operations and unrelated denials first, following the IAM runbook.
Install only for the authorized environment. This enrolls the new stack,
function, artifact bucket prefix, exact schedule, log group and four alarms;
it does not let the GitHub role change its own policies or runtime role.

1. `dbMigrationsLoop` with `db_schema_scope=voting-credit-returns`. This syncs only
   the two new entities and avoids unrelated schema work.
2. `pushNotificationsHandler` and then `api` (both understand the new cause).
3. `waveDecisionExecutionLoop`, then `artCurationNftWatchLoop`, capturing every
   winner path. Author deletions are captured by the updated API.
4. `votingCreditReturnNotificationsLoop`. Its schedule is disabled by default.
5. Refresh operational monitoring for the authorized environment with
   `deploy-operational-monitoring.yml` after the new log group exists. The
   generated coverage/source templates include the new worker.
6. The dependent frontend, including generated API types and the new card.
7. Activate the worker schedule after checking the frontend live version and
   health. Repeat activation after any subsequent deployment of this worker:
   Serverless deliberately restores its disabled default.

Set the authorized region and environment, then resolve the exact rule from its
CloudFormation stack. Never change another worker's rule:

```bash
credit_return_rule="$(aws cloudformation describe-stack-resources \
  --region "$release_region" \
  --stack-name "votingCreditReturnNotificationsLoop-$release_environment" \
  --query 'StackResources[?ResourceType==`AWS::Events::Rule`].PhysicalResourceId' \
  --output text)"
[ -n "$credit_return_rule" ] && [ "$credit_return_rule" != None ]
aws events enable-rule --region "$release_region" --name "$credit_return_rule"
aws events describe-rule --region "$release_region" --name "$credit_return_rule" \
  --query '{Name:Name,State:State,ScheduleExpression:ScheduleExpression}'
```

Keep `USER_NOTIFIER_ACTIVATED` enabled for processing; disabling it pauses the
worker without consuming snapshots. Push delivery also respects its existing
activation switch, per-device vote preference and native-competition support.

Smoke checks: release a 500-credit allocation by winning and by author deletion;
verify immediate reusable credit and one notification with the saved title and
amount; verify the deletion notification links only to its competition. Reinvoke
the worker to check that no duplicate row appears. Observe pending release age,
Lambda errors and the existing push outbox. Run the related frontend E2E pack.

For rollback, use `aws events disable-rule` for the resolved rule. Pending
snapshots remain durable while voting, deletion and decisions continue. Roll back
application code only through reviewed sources and the ordinary workflows; keep
the additive tables. Re-enable only with compatible readers, push worker and UI.

## Failed releases and depth

The worker emits CloudWatch EMF counts for `PendingReleases` and
`DeadLetterReleases` in `VotingCreditReturns`, without making a metrics API call.
Depth above 20 releases, age above five minutes, and any dead-lettered release
have alarms. After ten failed attempts a release is parked with
`dead_lettered_at`; its recipients remain stored and no notification is marked
completed. Fix the underlying error, then requeue only the affected release ID
by clearing `dead_lettered_at`, setting `attempts=0`, and setting
`next_attempt_at` to the current epoch milliseconds. Never delete pending
snapshots as a recovery step. Retry-update failure preserves the original error
for diagnosis. Metrics failures do not block notification delivery.

Re-invoking the worker is safe: notification rows, push-outbox rows and release
progress share a transaction. A committed page is never recreated; a failed page
rolls back all effects. `push_notification_outbox.notification_id` is already a
primary key. An empty/filtered notification batch does not touch the outbox.
