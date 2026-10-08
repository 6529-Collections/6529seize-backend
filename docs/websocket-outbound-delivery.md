# WebSocket outbound delivery

## Business commit to delivery

Persistent changes now write a resource event to `websocket_outbox` in the same
MySQL transaction as the change. An outbox insertion failure fails that
transaction. Shared mutation methods reuse the caller's transaction or open one
when previously called in autocommit mode. There is no database/SQS dual write
that can report a committed change while silently losing its delivery intent.

The capture points cover drop creation/editing and permanent/bulk deletion,
reactions, voting, poll responses, boosts, preview visibility, moderation,
notification insertion/read state, DM unread versions and identity muting,
attachment transitions, NFT resolution/preview changes, and drop media status.
Editing a drop internally deletes and reinserts it; that internal deletion must
not create a permanent-deletion event. Typing is ephemeral and does not require a
business outbox. Authentication and identity-sync acknowledgements remain inline.
Local development retains direct WebSocket delivery rather than accumulating an
undrained outbox.

Existing post-commit notifiers enqueue a wakeup on `websocket-outbound.fifo`
for capable clients and retain immediate Gateway fan-out to legacy clients.
Failure emits `WS_OUTBOX_WAKEUP_FAILED`; the durable event remains. A one-minute
EventBridge schedule invokes the same `websocketOutboundHandler` to recover
missed wakeups and deferred retries. No additional Lambda service is introduced.

The production NFT refresher injects this wakeup into its notifier and then
broadcasts only to legacy clients. Its ten-send concurrency limit and 15-second
deadline apply to immediate legacy/local fan-out; producer cancellation also
reaches the Gateway transport. These limits do not govern capable-client outbox
resolution or retry and cannot discard that committed delivery intent.

The worker first resolves the resource's current state and permitted audience
using the writer database, then atomically replaces its resource event with
recipient jobs in the outbox. Thus a large fan-out has durable progress: failure
for one recipient does not require republishing the entire audience. Drop
updates use `DROP_UPDATE_REF`, causing the client to fetch canonical content;
deletions preserve their routing metadata after the drop row disappears.

A recipient job is deleted only after SQS accepts its session-bound frame.
Unknown acceptance/commit outcomes may retry the same job. Its stable envelope ID
supports FIFO deduplication within SQS's deduplication interval; consumers must
still tolerate duplicates beyond that interval. Each connection has one hashed
outbox partition and one hashed FIFO group. A deferred or locked earlier job
blocks later jobs for that connection, while independent connections can proceed.
Resource events for the same resource also resolve in outbox order. This is not
a total ordering of concurrent business transaction commits.

The drain processes at most 100 jobs with four database/publication workers per
invocation, stops starting jobs near the Lambda deadline, awaits in-flight work,
and schedules another wakeup after making progress. Failed jobs remain in MySQL
with an exponential retry delay capped at one minute. Partial recipient-job
inserts roll back to a savepoint. Outbox rows have no automatic expiry; failures
must be investigated rather than discarded. Original event age is retained when
materializing recipient jobs.

The push worker also durably captures invalidations from its existing SQS input,
covering records made by producers predating this rollout. Duplicate identity
invalidations are safe canonical-cache refresh hints. This does not change
Firebase delivery or the push worker's event-source concurrency. The separate
`push_notification_outbox_entries` introduced by the push-delivery work remains
intact: notification inserts can record both push and WebSocket intent in the
same business transaction, while each outbox has its own publisher and recovery.

## Gateway retries and authorization

`websocketOutboundHandler` consumes one FIFO record per invocation, with maximum
SQS concurrency 16 and Lambda reserved concurrency 20. The Gateway transport uses
three standard SDK attempts with jitter, bounded concurrency and a five-second
send deadline. Exhaustion, queue overflow, and deadlines remain errors and cause
partial batch failure. Visibility backoff starts at 1–2 seconds and caps at 60
seconds; failed visibility changes retain the 180-second default. Retries do not
reset the receive count.

SQS retains frames for four days and moves failures after 100 receives to a
14-day FIFO DLQ. DLQ handling requires investigation; it is not successful
delivery. Redrive can reorder old frames relative to newer acknowledged frames,
so reconcile client state when old snapshots are no longer appropriate.

At delivery, the worker verifies the captured identity/JWT generation, current
notification subscriptions, wave/parent permissions, and attachment access.
Revoked access or replaced/expired sessions intentionally cancel obsolete work.
Only genuine disconnection/expiry permits stale-connection cleanup; throttling
never does. Typing older than ten seconds is intentionally expired.

SQS uses managed encryption. Outbox recipient rows and queue bodies contain
routing IDs and serialized frames; normal database access controls apply.
Failure logs omit message bodies, raw connection IDs and provider exception text.
Gateway acceptance is not a browser acknowledgement, and no exactly-once claim
is made. Disconnected clients recover current state through REST rather than
receiving another session's queued frames.

## Client compatibility

The frontend advertises `delivery_capability=durable_updates_v1` in the WebSocket
connection URL, including anonymous connections and every reconnect. This is a
public protocol capability, not a credential or authorization grant. JWTs remain
in the existing authentication message. The API accepts only the exact supported
value on `$connect`, stores `ws_connections.durable_updates`, and defaults
missing/unknown values and pre-existing rows to false. Capability is fixed for a
physical connection; reauthentication and notification identity synchronization
cannot upgrade or downgrade it. Each tab/desktop connection is classified
independently, even when multiple sessions belong to the same profile.

New business events carry the capability marker through resource resolution and
recipient-job materialization. The worker selects only capable connections for
these jobs; post-commit notifiers select only legacy connections and send their
existing immediate payloads. The shared sender rechecks the connection mode, so
legacy fan-out cannot also queue a capable client's update. Typing and other
non-transactional frames use the same per-connection direct/queued selection;
authentication control replies remain inline for both modes. Capability never
bypasses expiry, subscription or resource-access checks. Delayed frames with a
capability marker are canceled if the current connection is incompatible.

Outbox events and queue frames accepted before this change lack the marker. They
retain their original audience/delivery contract so deployment does not silently
discard pending work. Old unmarked media events retain that mode through their
child events. Unknown non-empty markers are retained as errors, not interpreted
as legacy. This is a backlog compatibility exception, not a direct-send fallback
for newly marked work.

Backend and frontend releases no longer require simultaneous client updates.
After the backend fleet is updated, old browser tabs and old Core versions keep
immediate legacy delivery with its existing missed-send risk. Updated frontend
connections opt into durable delivery; Core does so when its normal frontend
subtree sync and desktop release include this frontend version. No separate Core
code or activation flag is required. Updated frontend on an older backend also
works: the older backend ignores the public parameter and uses its legacy path,
while the frontend's stale/deletion guards remain active.

[Frontend PR #4128](https://github.com/6529-Collections/6529seize-frontend/pull/4128) rejects older full-drop revisions in both live
state and query caches, remembers observed deletions for the provider lifetime,
and rechecks asynchronous fetch results before applying them. Older NFT snapshots
cannot overwrite a newer successful refresh. Equal drop revisions remain allowed
because reactions and votes can change without editing the drop. Notification
invalidations already refetch canonical state; DM unread state already rejects
older/equal versions; finalized attachments already resist pending-state replay.
Compact drop references use the existing bounded canonical-fetch retry/coalescing
path. These protections cover stale delivery, not offline event replay or browser
acknowledgements.

## Health, rollout and rollback

The scheduled drain emits outbox pending count and oldest-event age using
CloudWatch Embedded Metric Format. An age above 180 seconds for two periods, or
missing scheduled health metrics, alarms to the existing topic. Source queue age
and DLQ alarms remain. Investigate `WS_OUTBOX_PUBLISH_FAILED`, wakeup failures,
Gateway failure diagnostics and backlog together; fewer error logs alone do not
prove delivery.

Publication failures include a fixed `phase` (`decode`, `resolve`, `materialize`,
or `enqueue`) and safe `error_class`, alongside the row ID, attempt and age.
Exception messages, stacks, SQL and payloads are not logged. Shared WebSocket
constants and exceptions live in a dependency-free module so repository-first
worker initialization cannot construct a sender with an undefined repository.
A bundled worker import test covers initialization through recipient enqueue.
For this initialization repair on an already provisioned outbox rollout, deploy
`websocketOutboundHandler` and verify retained backlog drains plus fresh delivery.
The API can pick up the shared-module refactor on its next deployment; producers,
frontend, schema and queue configuration do not require a coordinated redeploy
for this repair. The full initial architecture rollout below still applies.

Required service order:

1. `dbMigrationsLoop` creates the outbox entity/table and indexes and adds
   `ws_connections.durable_updates` with default false via normal schema
   synchronization. Run it before any binary that reads or writes the capability
   column, including the API and worker. No handwritten migration is required.
2. `websocketOutboundHandler` provisions the FIFO queue/DLQ, schedule, alarms and
   publication consumer. Verify database and queue access before producer rollout.
3. Redeploy `api` (`seizeAPI`) for capability-aware connection registration and
   producer routing, then the remaining producers listed below. Deploy the
   capability-aware worker before producers emit marked events.
4. Deploy the companion frontend at any point after its backend prerequisites.
   Deploying backend first is safe for legacy clients; frontend first against
   older backend also retains legacy delivery. Keep the frontend protections in
   place before redriving old snapshots to capable clients.

Producer deployment units: `api` (`seizeAPI`), `releaseNotesGenerationLoop`, `helpBotReplyLoop`,
`nftLinkRefresherLoop`, `nftLinkMediaPreviewLoop`, `dropMediaSanitizer`, `attachmentsOrchestrator`,
`attachmentsProcessor`, and `pushNotificationsHandler`. The `helpBotReplyLoop`
deployment also includes `helpBotDailyActivityCreditLoop`. NFT preview mutations
capture outbox intent too, so the separately deployable `nftLinkMediaPreviewLoop`
has the same worker prerequisite as the refresher.

For full transactional capture across background notification producers, also
redeploy `overRatesRevocationLoop`, `waveDecisionExecutionLoop`, `tdhHistoryLoop`,
`tdhLoop`, `subscriptionsTopUpLoop`, `subscriptionsDaily` (including its
`subscriptionCoverageReconciliationLoop` Lambda), `nftsLoop`, `claimsBuilder`,
`claimsMediaArweaveUploader`, and `s3Uploader` after the worker. These include
subscription and vote-revocation notifications and configured priority alerts.
The service catalog records the worker prerequisite. The push-input handoff
preserves existing queued invalidations during mixed-version rollout; an old
producer binary continues its existing best-effort delivery path, but does not
have the new business-transaction guarantee. Old producers that publish through
the push input are retained by that handoff; other old producers still call API
Gateway directly. Partial fleet rollout therefore retains the old failure risk
until those producers are upgraded; it does not intentionally disable their
sends. A producer binary from the earlier, unnegotiated outbox version can still
create unmarked work for legacy clients; retained backlog may also reach them
asynchronously until drained. Complete the capability-aware producer rollout to
establish the per-client split. Old direct-send producers can still send to
capable clients during rollout, so the frontend guards must remain active.
Upgraded producers deliberately split legacy immediate delivery from capable
outbox delivery; never add an immediate fallback for capable clients.

For rollback, stop or roll back producers first. Retain the outbox table and
both queues, and explicitly drain or retain pending work before disabling the
worker. Never drop pending work as a rollback shortcut.

Validation must exercise real MySQL rollback, failed SQS acceptance, partial
fan-out rollback, deferred-head ordering, missed-wakeup scheduled recovery,
SDK 429-to-success, cancellation, authorization revocation, stale/deleted client
updates, mixed legacy/capable sessions of the same profile, anonymous and
reconnected capability registration, pre-capability backlog, and bounded burst
drain. Local synthetic failures do not establish
production load capacity. A controlled staging rollout still needs to verify the
new table, scheduled recovery and alarms; no deployment is implied by this PR.
