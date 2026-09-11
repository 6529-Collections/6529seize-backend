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
  alert delivery and installation revocation also acquire this device lock;
  Android rechecks recipient registrations without calculating numeric badges.
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
  Token groups for one device run sequentially within a refresh batch, while
  distinct devices run concurrently. Across workers, a losing group retries
  through SQS and recalculates the whole-device count. It can proceed once the lock is released;
  it does not need to wait for a stale-token registration to disappear. Repeated
  contention remains subject to the existing dead-letter policy.

## Platform and rollout boundaries

- iOS platform matching tolerates casing and surrounding whitespace on existing
  registrations. Null/unsupported platforms cannot safely be inferred: corrective
  updates are skipped, and ordinary alerts omit the badge instead of guessing a
  count. A later canonical iOS registration restores badge synchronization.
- Exact badge refreshes apply only to iOS. Android visible pushes with a target
  profile carry `android.notification.tag` as
  `6529:v1:<encoded-profile-id>:<notification-id>:<encoded-wave-id>` (the final
  field is empty outside a wave; string fields use URI component encoding).
  This preserves payload identity through the native delivered-tray API, which
  may omit FCM custom data. Native removal must retain both the returned ID and
  tag. Distinct profiles/notifications have distinct tags; a retry of the same
  notification replaces that entry. No Android numeric badge guarantee is made.
- Badge-only pushes do not implement selective removal of already delivered
  notifications. Pair this change with
  [frontend profile-scoped cleanup](https://github.com/6529-Collections/6529seize-frontend/pull/3948).
  That client reconciles confirmed read entries while it executes, without
  overwriting the iOS badge. Older clients retain their global-cleanup behavior.
- No native package or mobile release is introduced. Before production rollout,
  verify badge-only behavior on an existing installed iOS app in foreground and
  background with badge permission enabled: 2 → 1, single-profile 1 → 0, and a
  rapid read followed by a new push. This includes the badge-only `alert` push
  type. Confirm no alert or sound is produced and record what remains in Notification Center. Backend tests cannot establish
  the behavior of the installed native delegate or APNs delivery.
- Deploy `dbMigrationsLoop` first to synchronize `push_notification_device_installations`, then
  `pushNotificationsHandler`, then `api`, then the frontend. Older workers do not
  understand installation refresh messages. No new queue or Lambda is needed.
  The existing `PUSH_NOTIFICATIONS_ACTIVATED` API switch controls enqueueing.
- The companion frontend documents profile-scoped reads and installation logout.

## Native logout and installation ownership

`POST /push-notifications/installations/revoke` accepts an installation secret,
monotonic revision, `all_profiles`, optional `profile_id`, and exact native
refresh-token/address pairs. The installation credential authorizes device
cleanup without a live wallet JWT, allowing the secure client outbox to finish
an offline logout after local accounts are removed. Each supplied refresh token
revokes only its matching native session; other devices and web sessions remain.

This route runs behind the shared API rate-limiting middleware, including for
requests without a wallet JWT. With `API_RATE_LIMIT_ENABLED=true` and Redis
available, ordinary anonymous requests use the IP-based limits (defaults: 30
burst, 10 sustained requests/second). The shared middleware has its existing
fail-open behavior; this is not a claim about deployed API Gateway throttles.
Verify the API rate-limit configuration during rollout. Installation credentials
are still required, and the device lock rejects revocation if Redis coordination
is unavailable.

Registration preserves the previous device upsert: only token and platform
change on an existing profile/device row. It does not seed or overwrite settings;
missing settings continue to use `DEFAULT_PUSH_NOTIFICATION_SETTINGS` at read
time. Session creation normalizes addresses to lowercase, as do the matching
logout lookups. The early-claim session lookup intentionally holds its matching
row lock until commit against concurrent revocation/rotation; the refresh hash
is unique and the search stops on its first valid session.

A single logout deletes `push_notification_devices` and settings for the selected
profile/device. Sign-out-all deletes every registration/settings row for that
device, including forgotten local profiles. A sessions-only revocation omits the
profile when another connected wallet still owns it or the account has no profile.
The frontend removes identifiable profile tray entries for a single logout and
uses global native tray removal only for explicit sign-out-all.

The durable `push_notification_device_installations` row stores a SHA-256 installation-secret hash,
revocation revision, and latest FCM token/platform. It survives profile deletion
so the worker can send badge zero after the last registration disappears.
Revocation commits first, then enqueues `installation_badge_refresh` by device ID.
A failed queue handoff returns an error for client retry. Repeated revisions are
idempotent and cannot erase a later login; new registration must present the
current revision. Registration and revocation lock the same database row.
If the client never retries a failed logout queue handoff, the registrations
remain deleted but the badge can stay stale. The retained installation record
does not schedule its own reconciliation. Recovery requires the client to retry
its saved revision and complete the enqueue; deleting the secure outbox loses
that recovery path. This limitation applies to logout separately from read-event
publication failures.
Revocation and final push recipient validation/submission also share the Redis
device lock. Already accepted FCM/APNs pushes cannot be recalled by this fence.

The Redis lock ends before enqueueing; it does not span the asynchronous refresh.
Registration uses the database row lock and revision fence, while the refresh
worker reads the latest registrations and token. A deliberate login before the
refresh is therefore included in its count. Revocation must not bypass Redis
during an outage: a pending alert could otherwise submit after its last recipient
check and after logout. The client keeps that revocation queued until coordination
recovers. Installation lookups use the `device_id` primary key; the additional
token predicate during invalid-token cleanup protects a concurrent replacement,
so there is no token-only lookup requiring another index.

Installation credentials are two independently generated UUIDv4 values (244 random
bits), stored only in native secure storage. Their SHA-256 digest is a verifier,
never an accepted bearer value. A read-only database leak therefore does not
supply a usable installation credential, and password-style dictionary guessing
is not the threat model. Retaining this independent verifier also avoids coupling
long-lived installation ownership to the auth-session HMAC key configuration or
rotation. Native session proofs still use the existing keyed `hashSecret` format
to match their session records; that authentication policy is unchanged.
The revocation database operation returns only device ID and revision on both
first execution and retries. Neither the stored verifier nor FCM token leaves
that persistence boundary through the revocation result; the public response
contains only the revision.

A mixed-session logout checks every supplied address/token pair independently.
Authenticating one native session for an early installation claim does not
authorize revoking another session without its exact refresh token. Redis busy
or unavailable errors leave the client outbox intact for a later activation,
reconnect, or pre-registration retry. Both iOS and Android final alert delivery
use this same coordination so a logout cannot race the last recipient check.
The added Android Redis lookup and recipient query are an intentional latency
and availability tradeoff; a failed lock requeues the alert instead of sending
against an unchecked registration.

The installation refresh worker reads the latest token and whole-device count,
including profiles whose rows retain older tokens during rotation. It sends no
numeric badge update on Android. Failed counts do not become zero. Invalid FCM
tokens are retired conditionally without deleting a concurrent replacement.

For an unclaimed legacy device, the first credential must prove knowledge of the
FCM token on every existing registration row, or the retained installation token
when those rows have already been removed. Authenticated registration can establish a fresh installation with neither
registrations nor a retained token. Logout before the first registration instead
requires a matching, unexpired, unrevoked native refresh session. Anonymous requests
cannot pre-claim an installation using only its device ID and a new secret.
Native-session proof never substitutes for an existing installation secret or
legacy FCM-token proof. It authorizes only the initial binding when no registration
or retained token exists; the legacy token checks still run after the session
helper returns. A caller's valid native session cannot claim another registered
installation, including one whose final registration was removed but whose token
was retained.
Successful early logout stores its revision fence and later retries use the
installation secret, even after that logout revoked the native session. If the
initial request has no valid session proof, cleanup remains pending; this also
covers a never-registered client's session expiring before offline reconciliation.
Device IDs are visible to profiles and do not authorize device-wide deletion by themselves. Conflicting legacy
tokens or a lost installation credential require operator-assisted reconciliation
after ownership verification; the client keeps cleanup pending and blocks new
registration rather than taking over another profile's rows. Once claimed, legacy
registration calls without the secret are rejected. Keep the schema on rollback;
roll back the frontend before API producer changes, then drain jobs before
rolling back the worker. Old clients cannot register against a claimed installation.

Offline logout is eventually reconciled only when the client can run and reach
the API. Secure-storage failure prevents local credential removal; clearing app
data can lose the pending outbox. This client outbox does not change the separate
best-effort queue handoff for ordinary notification read operations.

APNs references: [payload keys](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/PayloadKeyReference.html)
and [push request headers](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
