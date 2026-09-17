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
Native refresh tokens are generated and rotated with `randomBytes(64)` (512 bits),
returned to the client establishing or refreshing that session, and stored as a
keyed hash in the database. The mobile client keeps the bearer token in native
secure storage and a process-local cache, not in device-list responses. Revocation
requires the exact token for each supplied session; installation proof alone does
not authorize revoking other sessions. A stolen bearer token can revoke its own
session, so its confidentiality remains part of the auth contract.

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
time. Session creation normalizes addresses to lowercase. Logout comparisons
normalize both stored and supplied addresses, so older mixed-case rows match
independently of database collation. The unique refresh-token-hash lookup still
restricts the candidate session. An early logout requires a live native session,
but that proof never grants device ownership. Session proof uses a non-locking
read; native session updates acquire row locks in refresh-hash/address order,
including when different installations supply the same sessions in reverse order.
Auth session creation/refresh/revocation does not acquire push-table locks, so it
does not introduce the reverse sessions-to-installations lock order.
The API accepts at most 50 session pairs per request; include their primary
latency when verifying the limiter at rollout.

A single logout deletes `push_notification_devices` and settings for the selected
profile/device. Sign-out-all deletes every registration/settings row for that
device, including forgotten local profiles. A sessions-only revocation omits the
profile when another connected wallet still owns it or the account has no profile.
Every revoke variant, including sessions-only, advances the installation revision.
The client increments and securely persists that revision with its queued logout
before sending the request, retries with the same revision, and drains pending
logouts before registering with the stored current revision. Sessions-only logout
must follow this same sequence even though it retains profile registrations.
The frontend removes identifiable profile tray entries for a single logout and
uses global native tray removal only for explicit sign-out-all.

The durable `push_notification_device_installations` row stores a SHA-256 installation-secret hash,
revocation revision, and latest FCM token/platform. It survives profile deletion
so the worker can send badge zero after the last registration disappears.
Revocation commits first, then enqueues `installation_badge_refresh` by device ID.
A failed queue handoff returns an error for client retry. Repeated revisions are
idempotent and cannot erase a later login; new registration must present the
current revision. Registration and revocation lock the same database row.
An authenticated stale retry may return a higher stored revision than requested.
The frontend treats success as acknowledgement of that queued job and does not
overwrite its securely stored revision with the response, avoiding a rollback.
An empty sessions-only request still fences older registrations. For a claimed
installation, advancing the revision requires installation ownership and the
exact next revision, so knowing a device ID cannot exhaust or race that counter.
Locking rejects a missing transaction connection before issuing any query.
Unclaimed installations start at revision zero, and the API requires revoke
revisions of at least one. Once claimed through registration or legacy token
proof, ownership is retained and verified before accepting a stale retry.
Before registration, a separate `push_notification_device_logout_fences` row
stores only `(device_id, secret_hash, revision)`. It fences that secret's delayed
registration requests without claiming the device ID or retaining an unverified
FCM token. Another credential can still register the device at revision zero.
Authenticated registration transfers its own fence into the installation row and
deletes that fence in the same transaction. Other secrets' fences confer no
ownership and cannot revoke the now-claimed installation. Unconsumed fences are
retained for offline retry correctness; no expiry or background purge is assumed.
If the client never retries a failed logout queue handoff, the registrations
remain deleted but the badge can stay stale. The retained installation record
does not schedule its own reconciliation. Recovery requires the client to retry
its saved revision and complete the enqueue; deleting the secure outbox loses
that recovery path. This limitation applies to logout separately from read-event
publication failures.
Revocation and final push recipient validation/submission also share the Redis
device lock. Already accepted FCM/APNs pushes cannot be recalled by this fence.
The revocation transaction holds that Redis lock through the primary database
commit. A slow write therefore delays concurrent alert delivery for the same
device; contention retries through SQS. Enqueueing happens after releasing the
lock, before the worker acquires it separately for the badge refresh.

The Redis lock ends before enqueueing; it does not span the asynchronous refresh.
Registration uses the database row lock and revision fence; it does not acquire
the Redis device lock. Redis coordinates revocation with worker recipient checks
and submissions, not registration with delivery. A login committed before the
worker reads registrations is included in that count. A registration committed
after a single-profile logout contributes only profiles currently registered;
the deleted profile remains excluded unless deliberately registered again. Before
the first registration, an early logout has no profile row to delete: its secret's
revision fence rejects delayed registration with the old revision, while another
credential can establish the installation. A valid subsequent login can therefore
receive a nonzero aggregate badge without restoring the logged-out registration.
A registration committed after the read can leave the submitted badge temporarily
stale until a later read/unread event or ordinary push recalculates it; registration alone does not
schedule a corrective badge update. Revocation must not bypass Redis
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
contains only the revision. The unsigned revision ceiling is enforced by both API validation and the frontend; the client rejects overflow before changing its durable outbox.

A mixed-session logout checks every supplied address/token pair independently.
Authenticating one native session for an early logout fence does not establish
device ownership or authorize revoking another session without its exact token. Redis busy
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
Retirement applies only to `messaging/invalid-registration-token` and
`messaging/registration-token-not-registered`. These identify an invalid delivery
token, not a profile-specific refusal: storing the same token again does not make
it valid for another connected profile. Transient, authentication, and generic
payload errors do not delete registrations. See
[Firebase's Admin SDK error semantics](https://firebase.google.com/docs/cloud-messaging/error-codes#admin_sdk_error_codes).

For an unclaimed legacy device, the first credential must prove knowledge of the
FCM token on every existing registration row, or the retained installation token
when those rows have already been removed. Authenticated registration can establish a fresh installation with neither
registrations nor a retained token. Logout before the first registration instead
requires a matching, unexpired, unrevoked native refresh session to establish only
its own credential-scoped logout fence. Even a caller with a valid native session
cannot reserve an arbitrary never-registered device ID: the installation row
remains unclaimed, its token/platform remain empty, and another credential may
register normally. Existing ownership still requires the installation secret or
legacy FCM-token proof; native-session proof never substitutes for either.
Successful early logout stores its separate fence and later retries use the
same secret, even after that logout revoked the native session. If the
initial request has no valid session proof, cleanup remains pending; this also
covers a never-registered client's session expiring before offline reconciliation.
Device IDs are visible to profiles and do not authorize device-wide deletion by themselves.
The frontend now binds a fresh push device UUID to the existing native Device
plugin identifier. The first upgrade from an unbound UUID, and a backup restored
onto a different native device, create a separate registration namespace and
credential. Original logout requests remain stored with their original identity,
secret and revision. An old namespace's failure no longer blocks registration or
logout on the current phone; a failure within the current namespace still blocks
registration until its logout is reconciled.

Migration uses `token_scoped: true` on the revocation endpoint, with an independent
cleanup credential and revision. Under the existing device and database locks,
it removes only rows for the old device ID and the exact current native FCM token.
It does not claim the legacy installation, advance its registration revision,
revoke native sessions, or delete a different token's registrations. Initial
cleanup requires token ownership or a live native session to establish its own
fence; subsequent retries are idempotent. After its final matching row is removed,
the old installation's matching retained token is cleared to prevent stale badge
jobs targeting the replacement phone. This cleanup does not enqueue an old-device
badge correction. Replacement registration enqueues the new device's badge refresh.

Profile preferences survive logout. Authenticated registration may supply
`previous_device_id` to copy only the acting profile's preferences when the new
installation has none. Existing destination preferences win. Verified modern
registration updates the token/platform for all profiles on that installation;
legacy registrations retain their original per-profile behavior. Other device IDs
are unaffected.

Unproven old-token registrations are deliberately preserved: moving to a new phone
is not authority to sign another phone out. Legacy conflicting cleanup may remain
pending for support review, but does not prevent the replacement from receiving
pushes. Lost or unreadable current credentials still fail closed. No database wipe
or operator enrollment is required for the new installation to register. Once
claimed, legacy registration calls without the secret are rejected. Keep the schema
on rollback. A migrated client needs its device binding and multi-installation
outbox reader preserved; reverting to the older storage reader is unsafe. Keep
the recovery API available until a compatible client is in place and pending
work drains before rolling back the worker. Old clients cannot register against a claimed installation.

Offline logout is eventually reconciled only when the client can run and reach
the API. Secure-storage failure prevents local credential removal; clearing app
data can lose the pending outbox. This client outbox does not change the separate
best-effort queue handoff for ordinary notification read operations.

APNs references: [payload keys](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/PayloadKeyReference.html)
and [push request headers](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
