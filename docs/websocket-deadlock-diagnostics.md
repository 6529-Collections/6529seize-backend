# WebSocket deadlock investigation

The API logs bounded `ws_operation` and `ws_transaction` diagnostics for socket
registration, authentication, notification identity sync, disconnection, and
sampled stale-subscription cleanup. These diagnostics preserve the existing
transaction boundaries, lock order, three-attempt deadlock
retry, cleanup sampling, and outbound delivery behavior. They do not change the
generic operational alert classification or suppress existing error events.

## Follow an operation

1. Find the `MYSQL_HELPERS` error in `/aws/lambda/seizeAPI` and use its request
   ID to locate the `ws_transaction` record. The connection lookup and
   subscription mutation/cleanup callbacks bind their issuing invocation context,
   including when a physical MySQL socket originated in an earlier invocation.
2. Follow `operation_id` across transaction attempts, cleanup, and the final
   `ws_operation`. `mutation_id` distinguishes a mutation's attempts from cleanup
   or transport-loss deregistration within the same operation.
3. Compare `lambda_request_id` with Lambda's `START`/`REPORT` records and
   `gateway_request_id` with API Gateway access logs. `socket_hash` is a SHA-256
   digest of the connection ID and correlates separate requests on one socket.
   Raw socket IDs, identities, JWTs, frame bodies, SQL parameters, and exception
   messages are not included in the new structured records. Existing application
   logging retains its previous policy.
4. Inspect `phase`, `attempt`, `max_attempts`, `mysql_code`, `mysql_errno`,
   `mysql_sqlstate`, `attempt_ms`, and `total_ms`. A `retry_pending` attempt is
   followed by a new attempt; `committed` with `recovered=true` establishes that
   the repository-owned transaction committed after retry. `retries_exhausted`
   identifies three failed deadlock attempts. A transport failure during
   `phase=commit` leaves `transaction_outcome=unknown`; do not infer rollback or
   replay it based on diagnostics.
5. Check `response_status` and `acknowledgement` separately. `accepted` means the
   API Gateway send returned successfully (or local `socket.send` accepted the
   frame); it does not prove client receipt. `failed` or `unavailable` can coexist
   with HTTP 200 because the existing send path is best effort. `not_attempted`
   means no matching control frame reached the instrumented transport. A
   `completed` operation describes the handler result, not guaranteed delivery.

For example, search the API log group with CloudWatch Logs Insights, replacing
`OPERATION_ID` with the UUID from a diagnostic:

```text
fields @timestamp, @message
| filter @message like /"event":"ws_(transaction|operation)"/
| filter @message like /OPERATION_ID/
| sort @timestamp asc
```

Caller-owned transactions log `statements_completed`, never `committed`, and
leave retry/commit authority to their caller. Cleanup logs
`transaction_owner=autocommit`; its two statements are separate existing
autocommit operations. Its final failure does not imply that an earlier cleanup
statement was rolled back.

The existing `SELECT ... FOR UPDATE` projects `CONNECTION_ID()` and
`@@session.transaction_isolation`. This adds no query round trip, session
assignment, or additional table scan. `db_session_id` describes the session
executing that locking query, not the driver's connection-handshake ID. When
using a proxy, validate that ID against the writer's report. `session_isolation`
is the observed session default, which does **not** reflect a next-transaction
`SET TRANSACTION` override. `isolation` records the repository's explicit
`READ-COMMITTED` option only after BEGIN succeeds; it stays null for caller-owned
transactions, cleanup, or acquisition failures. Session metadata stays null for
registration, cleanup, and locking queries that fail or return no rows. Success
records use INFO; keep `LOG_LEVEL_WS_DIAGNOSTICS=INFO` when overriding log levels for
an investigation. Unknown values are null or `OTHER`, never inferred from error
messages. No success should be inferred from a missing terminal record.

## Capture the database lock cycle

Application errors identify the victim statement; they cannot identify every
transaction holding or requesting the competing locks. On the **writer**, read:

```sql
SHOW ENGINE INNODB STATUS;
SHOW CREATE TABLE ws_connections;
SHOW CREATE TABLE ws_notification_subscriptions;
SELECT @@session.transaction_isolation;
```

The status report retains only the latest detected deadlock, which might already
have replaced the incident. Save its timestamp, participating transaction/session
IDs, statements, index names, lock modes, held/requested locks, and victim. Match
the incident time in UTC and `db_session_id` with the application records. Raw
engine reports can contain row values; retain them in restricted operational
storage rather than Discord alerts or public PRs.

For a bounded future capture window, record the existing Aurora cluster parameter
and log-export settings, enable the dynamic `innodb_print_all_deadlocks` cluster
parameter, and retain writer error logs through RDS download or CloudWatch error
log export. Restore the previous settings after the window and verify their
effective state. This code change does not enable those production settings and
does not query `SHOW ENGINE` on application failures. Use the normal authorized
operations process for any environment change; a database restart is not part of
this implementation.

Use the Aurora `Deadlocks` metric and application transaction records to establish
a baseline, recovery frequency, exhausted attempts, and authentication latency.
Database-wide metrics also include unrelated tables, so use the lock reports to
attribute them. See [Aurora's deadlock investigation guidance](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.BestPractices.FeatureRecommendations.html#AuroraMySQL.BestPractices.Deadlocks)
and [proxy session behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html).

## Captured gap-lock cycle and fix

A production writer report captured two AUTHENTICATE transactions for different
sockets inserting `ws_notification_subscriptions` rows. Both held an exclusive
lock on the same PRIMARY-index supremum gap and waited for the other's insert
intention lock. The victim's server session matched the application diagnostic,
and its second whole attempt committed. Neither transaction was cleanup.

The empty per-socket subscription DELETE under REPEATABLE READ locks that shared
gap before INSERT. A controlled two-socket replay reproduces the deadlock under
REPEATABLE READ. Repository-owned registration, authentication, identity sync,
and disconnect transactions now explicitly use READ COMMITTED through the
existing next-transaction isolation option. The same replay commits both first
attempts. Connection-row FOR UPDATE locks continue serializing mutations of the
same socket, and identity/grant replacement remains atomic. The option does not
change pooled session defaults, caller-owned transactions, or sampled cleanup.
Other deadlock causes can still occur; keep the existing whole-transaction retry.

## Investigate further lock cycles

Reproduce the captured statements in an isolated database with matching schema,
indexes, and isolation. Exercise authentication, notification sync, disconnect,
and cleanup on the same and different sockets, with explicit barriers to control
the observed interleaving. Compare cleanup enabled and disabled. Existing
synthetic error-code tests establish retry handling, not the production lock
cycle; the session diagnostic integration test likewise injects a driver error.

Use the report to decide between narrower cleanup scans/batches, consistent lock
order, query/index changes, or a narrowly scoped isolation change. If deadlocks
are rare and recover within the authentication budget, accurate recovery
reporting may be sufficient. Preserve atomic replacement of the socket identity
and notification grants, transaction ownership, and frontend acknowledgement
contracts in any subsequent fix. Then verify the same reproduction, latency,
and the full authentication/sync acknowledgement sequence.

## Deployment

Deploy only **`api`**. There are no schema, migration, frontend, OpenAPI, help-bot,
or service-dependency changes. The diagnostics are additive and can be rolled out
without a coordinated frontend release. Database engine capture, if separately
authorized, can precede API deployment so the first new trace can be matched to
its lock report. No architecture document update is needed because the system
boundaries and runtime transaction pattern are unchanged.
