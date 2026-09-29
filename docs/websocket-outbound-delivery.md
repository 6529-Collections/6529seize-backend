# WebSocket outbound delivery

## Acceptance and retry

Production notification senders await SQS acceptance before returning. There is
no direct-send fallback that can overtake a queued update. Authentication and
identity-sync acknowledgements remain synchronous control responses (including
credential rejection before a connection row exists); a failed control send
propagates to its caller. Local development retains its local WebSocket adapter. The FIFO group is a hash of the Gateway connection ID. Each
new frame has a unique envelope UUID, so content-based deduplication only
suppresses retries of that same envelope, not repeated intentional updates.
Ordering is queue acceptance order, not an ordering guarantee between concurrent
business transactions.

All application-update producers use the shared queued sender, including the
NFT-link refresher's `MEDIA_LINK_UPDATED` broadcast. The refresher retains ten
concurrent enqueue operations and a 15-second producer deadline; cancellation
is checked after session and queue-URL reads and forwarded to SQS writes.
Frames not accepted before the producer deadline are not durably retained.
The only direct application-side Gateway sends are the API's authentication
success/failure and notification-identity synchronization acknowledgements.
The worker's Gateway transport is the sole application-update delivery path.

`websocketOutboundHandler` processes one record per invocation with maximum SQS
concurrency 16 and Lambda reserved concurrency 20. Transport still uses three
standard SDK attempts with jitter. Exhausted SDK attempts, local sender limits,
and five-second send deadlines throw. Partial batch failure retains the frame;
the consumer changes its visibility to randomized exponential backoff, starting
at 1–2 seconds and capped at 60 seconds. If changing visibility fails, the
180-second default remains. The consumer stops at the first failure if batching
is ever increased, retaining all unprocessed records to preserve FIFO ordering.
No retry reinserts a new message or resets its receive count.

The deployed worker uses the API Gateway adapter; local development bypasses
the queue. Malformed envelopes or payloads are deliberately retained through the
same retry/DLQ policy rather than silently acknowledged. The retry error and
backlog alarms make these failures visible while preserving evidence.

The source retains work for four days. After 100 receives, SQS moves a failing
frame to a 14-day FIFO dead-letter queue. Dead letters and queue age above 60
seconds have CloudWatch alarms routed to the existing alarm topic. Dead-letter
handling is an operational recovery boundary, not successful delivery. Inspect
the root cause before redrive; old frames must not be replayed into new sessions.
Redrive can reorder old frames relative to newer acknowledged frames, so prefer
client state reconciliation where a replay is no longer valid.

## Session and payload safety

The envelope captures the connection's authenticated identity and JWT expiry.
Before sending, the worker rechecks the current connection and expiry. Missing
or expired connections are cleaned up. A changed identity or JWT generation is
reported with `WS_OUTBOUND_SESSION_CHANGED` and acknowledged without sending to
the replacement session. Notification and DM unread frames also recheck the
current profile subscription, reporting `WS_OUTBOUND_SUBSCRIPTION_CHANGED` when
it has been revoked. Wave-bearing frames recheck current child/parent read
access, and attachment frames recheck owner or current wave access. DM access
uses the subscribed profile, not a different active identity on a shared
connection. These are intentional authorization cancellations, not
transient delivery failures. A genuine Gateway 410 also permits cleanup.

Queue bodies contain recipient-specific serialized frames and connection IDs;
SQS managed encryption is enabled. Queue access is restricted to the existing
Lambda role. Failure diagnostics do not contain bodies, connection IDs or raw
provider exceptions. Queued payloads represent state at production time, not a
fresh query when delivered; no event coalescing is performed.

## Limits of the guarantee

SQS acceptance is the durability boundary. A database/queue outage or a producer
being killed before enqueue completes can still prevent acceptance. Enqueue
failure emits `WS_OUTBOUND_ENQUEUE_FAILED` and rejects; existing best-effort
notification callers may log that rejection after committing the business
operation. This change is not a transactional database outbox and must not be
represented as end-to-end guaranteed delivery.

Successful `PostToConnection` is not a browser acknowledgement. A lost transport
acknowledgement can cause duplicate frames on retry. Disconnected/re-authenticated
clients need REST reconciliation; this queue does not transfer their old frames
to a new connection. Long backlogs add latency, and authorization changes may
make old work undeliverable. Watch queue age, dead letters, enqueue failures and
Gateway failure categories together; a lower count of terminal errors alone is
not proof of correct delivery.

## Rollout and validation

Deploy `websocketOutboundHandler` first, including queue policies, FIFO source,
DLQ and alarms. Apply the regenerated operational-monitoring/source templates as part of the
authorized rollout so structured errors and Lambda failures/throttles include
the new worker. The queue resource policy explicitly grants the existing Lambda
role `sqs:ChangeMessageVisibility`; effective access (including any denies or
permission boundaries) must be verified in staging. Verify queue access, endpoint
secret loading and a synthetic
staging frame before deploying producers. Then deploy `api` (`seizeAPI`),
`pushNotificationsHandler`, `releaseNotesGenerationLoop`, `helpBotReplyLoop`,
`nftLinkRefresherLoop`, `dropMediaSanitizer`, `attachmentsOrchestrator`, and
`attachmentsProcessor`. The service catalog records the worker dependency.
Do not deploy producers before the queue exists. No schema or frontend change
is included. Firebase delivery and the push worker's event-source limits are
unchanged.

Validate normal frames, synthetic 429-to-success, expired transport budgets,
queue-enqueue rejection, FIFO progress after failure, session/subscription
revocation, backlog drain and DLQ alarms in staging. Use controlled traffic;
this PR does not establish production load capacity. In a rollback, stop or
roll back producers first and decide whether to drain or retain the queued work
before disabling the consumer. Never delete a queue containing pending work.

## Client compatibility findings before merge

Local adversarial validation against frontend main `2c5c9db623` reproduced
three delayed-snapshot hazards: a full `DROP_UPDATE` can overwrite a newer edit,
a full update arriving after an observed deletion can reinsert the deleted drop,
and an older `MEDIA_LINK_UPDATED` can replace a newer preview title/price and
successful-refresh timestamp. These are existing client behaviors whose impact
is amplified by durable delayed delivery. FIFO acceptance order does not solve
concurrent producer ordering or races against REST state. Do not treat the
normal staging smoke tests or passing sender tests as clearance of these cases.

Before merge readiness, add client-side stale/drop-deletion protection or
reconcile delayed payloads against authoritative state, including asynchronous
fetch completion after deletion. Retain regression tests for all three cases.
Notification invalidation already refetches canonical state; DM unread state
rejects older/equal versions. Attachment reconciliation prevents finalized to
pending regression, but that alone does not establish arbitrary snapshot ordering.

Producer acceptance also remains best effort: ordinary drop, notification,
attachment and NFT notification callers can log failed enqueues and return after
the business operation has committed. Bulk deletion attempts later recipients
then propagates failure; its post-commit caller may catch it. This is a confirmed
limit, not a worker retry bug. A transactional producer outbox is a separate
architecture change if durable delivery from business commit is required.
