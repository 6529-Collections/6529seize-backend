# Mobile badge synchronization

Notification reads on the website, desktop or mobile app request an asynchronous
refresh of the badges on the affected profile's registered iOS devices. A phone
with one profile moves from 1 to 0 after the final read; a shared phone with
UserA=1 and UserB=1 moves from 2 to 1 when UserA reads, then to 0 when UserB reads.
Updates depend on APNs delivery and the user's badge permission.

## Processing

1. Existing individual read, mark-all-read, wave-read and mark-unread operations
   persist their state and enqueue `{ "type": "badge_refresh", "profile_id": "..." }`.
   There is no new public API request/response shape. Device lookup, count queries
   and Firebase calls run outside the read API request.
2. The existing `firebase-push-notifications` SQS queue feeds
   `pushNotificationsHandler`. Its configured three-second delay is unchanged.
   Duplicate requests for the same device/token in a batch share one refresh.
3. The worker looks up current iOS registrations for the affected profiles and
   counts each distinct profile registered to each device once. Device push
   preferences and existing unread visibility, wave mute, profile mute, block and
   moderation rules still apply. This is the mobile push badge count, which can
   differ from the unfiltered in-app notification total.
4. Counts use the primary database, not a replica, React state or Notification
   Center item counts. Both normal iOS pushes and refreshes acquire the same
   device lock before counting and sending, including across token rotation.
   Lock contention is retryable;
   locks expire after 120 seconds, longer than the worker's 60-second timeout.
5. Firebase sends only `aps.badge` with the exact aggregate, including zero.
   There is no `notification` title/body, sound, feed item, redirect or
   `content-available` wakeup. APNs headers use push type `alert`, priority `5`,
   collapse ID `device-badge-refresh`, and expiration `0` to avoid storing stale
   corrective counts for an offline device. Ordinary visible pushes keep their
   own delivery semantics and are not collapsed with badge refreshes.

## Failure and concurrency behavior

- A failed or invalid count for any registered profile prevents a badge update.
  Successful counts are never summed with failed profiles treated as zero.
- SQS retries failed profiles, including when one of their devices fails after
  another succeeds. Every retry recalculates current state instead of replaying
  an old count. Existing partial-batch retries and the dead-letter queue apply.
- Registrations are checked again under the lock. Removed/rotated registrations
  are skipped. Invalid Firebase tokens are removed for all profiles whose stored
  token exactly matches the invalid one, preserving rows with a rotated token.
- Redis must be available for iOS badge-bearing delivery. If coordination fails,
  the worker retries rather than submit competing counts. A release failure is
  logged without masking the send result; the lock expires automatically. Android
  alert delivery does not acquire this lock.
- Queue publication is an awaited, best-effort handoff after persistence. A queue
  failure is logged and does not turn an already successful read into an API
  error. There is no transactional outbox: a failed enqueue or a process stopping
  between persistence and publication can leave the badge stale until a later
  read/unread operation or normal push updates it.
- Worker serialization prevents overlapping server-side badge submissions for
  the same device ID, including when connected profiles temporarily have different
  tokens during rotation. Counts include all profiles registered to that device.
  Serialization cannot guarantee immediate or ordered device-side delivery through FCM/APNs.
  A count can also become stale after it is submitted. This feature provides
  asynchronous reconciliation, not a synchronous device acknowledgement.
- Delivery grouping and locking have different scopes: `deviceBadgeKey` groups
  each device/token target, while `withDeviceBadgeLock` hashes only the device ID.
  Different token groups for one device can contend within the same batch as well
  as across workers. The losing group intentionally retries through SQS and
  recalculates the whole-device count. It can proceed once the lock is released;
  it does not need to wait for a stale-token registration to disappear. Repeated
  contention remains subject to the existing dead-letter policy.

## Platform and rollout boundaries

- iOS platform matching tolerates casing and surrounding whitespace on existing
  registrations. Null/unsupported platforms cannot safely be inferred: corrective
  updates are skipped, and ordinary alerts omit the badge instead of guessing a
  count. A later canonical iOS registration restores badge synchronization.
- This backend feature changes iOS badges only. Android notification payloads and
  launcher behavior remain unchanged. No Android numeric badge guarantee is made.
- Badge-only pushes do not implement selective removal of already delivered
  notifications. Frontend global cleanup can still remove another profile's
  notification; profile-scoped cleanup remains separate follow-up work.
- No native package or mobile release is introduced. Before production rollout,
  verify badge-only behavior on an existing installed iOS app in foreground and
  background with badge permission enabled: 2 → 1, single-profile 1 → 0, and a
  rapid read followed by a new push. This includes the badge-only `alert` push
  type. Confirm no alert or sound is produced and record what remains in Notification Center. Backend tests cannot establish
  the behavior of the installed native delegate or APNs delivery.
- Deploy `pushNotificationsHandler` before `api`: older workers do not understand
  the new queue message type. No DB schema/migrations or new queues are needed.
  The existing `PUSH_NOTIFICATIONS_ACTIVATED` API switch controls enqueueing.
- The frontend help corpus/mobile push guide should be updated with the deferred
  frontend cleanup feature after device behavior has been verified.

APNs references: [payload keys](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/PayloadKeyReference.html)
and [push request headers](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
