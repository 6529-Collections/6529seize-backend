# Push notification cancellation

Deleting a drop, purging chat history, or deleting a wave can remove a notification
before its queued push runs. Each deletion path now locks matching notification
rows, records their IDs, then deletes exactly those rows in the same transaction.
Both drop-reference predicates share one candidate scan; batches acquire primary-key
locks in ascending ID order to avoid reversed locks for crossed references.
A rollback restores both sides; failure to record cancellation fails the deletion.
The table contains only notification IDs and cancellation timestamps.

When a queued notification is missing:

- A cancellation record means acknowledge and log an informational skip.
- No cancellation record means retain the existing operational error and acknowledge.
- A database lookup failure means an operational error and retry for those IDs;
  other deliverable notifications in the batch can continue.

Lookups use the writer to avoid replication lag hiding a committed cancellation.
Existing notification delivery, badge computation, receipts, quarantine and the
five-minute monitoring frequency remain unchanged. A worker that already loaded
content before deletion can still send it; this does not recall delivered pushes.
Older deletions are not backfilled and can still produce missing-record alerts.

## Retention

Cancellation records remain for at least 30 days. Scheduled `dbMigrationsLoop`
maintenance deletes at most 10,000 expired rows per invocation, in 1,000-row batches.
This exceeds a maximum 14-day source queue stay plus a 14-day DLQ stay. Repeated
manual redrives can extend a message's lifetime beyond this window; an old missing
notification then alerts again rather than being silently classified as deleted.
Scheduled cleanup skips a table not yet created during rollout; other SQL failures
remain failures. Retention does not depend on push traffic.

## Deployment

Backend only. No frontend, mobile, OpenAPI or monitoring deployment is required.
Deploy in this order:

1. `dbMigrationsLoop`: run normal manual schema synchronization to create
   `push_notification_cancellations`, then verify the table exists.
2. `api` (`seizeAPI`): enable transactional cancellation in all deletion paths.
3. `pushNotificationsHandler`: enable cancellation-aware handling.

Keep the table when rolling back application services. Old deletion services will
not write cancellation records; the new worker will continue alerting for those
unexplained missing IDs. These changes do not repair historical missing records.

Cancellation covers rows actually removed by these deletion paths. It is not a
producer-side fence against creating new notifications after deletion. A concurrent
insert that survives remains an existing notification and goes through the worker's
normal content-visibility checks; it is not classified as an unexplained missing ID.
