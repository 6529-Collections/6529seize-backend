# Voting credit return notification rollout

Release capture is additive and does not change credit accounting. There is no
historical notification backfill. Author deletion applies only to permanent user
deletions of active entries, excluding admin/system cleanup and edit replacement.

Deploy sequentially using the ordinary deployment workflow:

1. `dbMigrationsLoop` with `db_schema_scope=voting-credit-returns`. This syncs only
   the two new entities and avoids unrelated schema work.
2. `pushNotificationsHandler` and then `api` (both understand the new cause).
3. `waveDecisionExecutionLoop`, then `artCurationNftWatchLoop`, capturing every
   winner path. Author deletions are captured by the updated API.
4. `votingCreditReturnNotificationsLoop`. Its schedule is disabled by default.
5. The dependent frontend, including generated API types and the new card.
6. Activate the worker schedule after checking the frontend live version and
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
