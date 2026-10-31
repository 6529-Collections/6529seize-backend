# End-to-end encrypted DMs and groups (delivery service)

Owner decision D109: every new private conversation (1:1 DM or group) uses
MLS (RFC 9420). Clients create and process all MLS state; the backend is a
ciphertext-only delivery service (DS) that orders key changes, stores
ciphertext for a bounded time and delivers hints. It issues no keys and
cannot add a device to a group. Existing plaintext DMs are unchanged.

The normative wire contract is the shared "E2EE DMs and groups (D109): shared
implementation contract v1". This page describes the backend's part of it.

## Ciphersuite

The only ciphersuite is `MLS_128_MLKEM768X25519_AES128GCM_SHA256_Ed25519`
(`0x004F`, 79): X-Wing hybrid post-quantum key exchange (ML-KEM-768 with
X25519), AES-128-GCM, SHA-256 and Ed25519 signatures. There is no fallback
suite. `0x004F` is a draft code point (draft-ietf-mls-pq-ciphersuites); if
the code point changes, every device re-enrolls and every group is
re-created. Device keys stay Ed25519, so their size is unchanged.

X-Wing public keys are 1,216 bytes and its ciphertexts 1,120 bytes, so MLS
objects are larger than under `0x0001`: a KeyPackage is about 2.7 KiB, a
fully populated ratchet tree about 2.7 KiB per device, and creating an
87-member group (one device each) makes a 233 KiB commit (256 KiB bucket)
and a 228 KiB Welcome. The limits below leave room for that.

The suite replaced `0x0001` before launch. Migration
`20261031120000-reset-e2ee-classical-ciphersuite-state` removes, once,
devices registered under any other suite together with their key packages,
groups (found through the roster), welcomes, log entries and attachments.
Reports are kept. Only staging and local databases had such rows. A client
whose device the server no longer lists wipes its local state and enrolls
again. A migration cannot delete S3 objects, so where blobs have a `storage`
column it removes only MySQL-stored attachments; rows of S3-stored ones stay
and blob retention deletes each object with its row. Staging ran the
migration before S3 storage reached this branch: its 2 classical blobs in S3
(about 328 bytes under the staging e2ee-blobs prefix) lost their rows and
remain as orphaned objects that nothing reads; deleting them is optional.

## Feature flag

`E2EE_DMS_ENABLED` controls every `/e2ee/...` route except the
trust-and-safety report routes (`/e2ee/trust-and-safety/...`), which stay
available so stored reports remain reviewable:

| Value | Result |
| --- | --- |
| `true` | On |
| `false` | Off |
| unset | On when `NODE_ENV` is `local` or `development` (staging); off otherwise, including production |

While off, every other route answers `404 {"error": ..., "code": "E2EE_DISABLED"}`
after the JWT check and before any proxy, profile or database check (a request
without a valid token still gets the usual 401). Production stays off; nothing
here authorizes enabling it there.

Other settings, read per request:

| Variable | Effect | Default |
| --- | --- | --- |
| `E2EE_ATTACHMENTS_ENABLED` | Kill switch for attachments, checked after `E2EE_DMS_ENABLED` (with both off, blob routes answer `E2EE_DISABLED`). `false` makes the attachment (blob) routes answer `404 E2EE_ATTACHMENTS_DISABLED` before any blob row or chunk is read or written; resolving the caller may still read the profile. `GET /e2ee/me` reports it as `attachments_enabled`, and clients hide attaching while it is false | On everywhere, including production |
| `E2EE_ENTRIES_PER_GROUP_PER_HOUR` | Commits and proposals one group may sequence per hour (an integer from 1 to 1000) | 12 (P35's value); 30 for `local` and `development`, so automated tests can churn groups |
| `E2EE_TRUST_AND_SAFETY_GROUP_ID` | An optional additional user group whose members may read reported encrypted messages, besides the content moderators (see Reports and trust and safety) | Unset: only content moderators |

## API

All routes are generated `x-6529-router` routes under `/api/e2ee/...` (see
`src/api-serverless/openapi.yaml`, tag "Encrypted Messages"). Each requires a
JWT, rejects proxies, requires a profile, and checks that every device the
caller acts as is an active (not revoked, not expired) device of the caller's
profile. Handlers live in `src/api-serverless/src/e2ee/`; the database layer
and pure helpers (digests, grant verification, policy, encodings) live in
`src/e2ee/`.

Errors use `CustomApiCompliantException` and the body
`{ error, code, current_epoch? }`. `current_epoch` accompanies
`E2EE_EPOCH_CONFLICT` and `E2EE_EPOCH_STALE` through the new optional
`details` of `CustomApiCompliantException`.

| Area | Routes |
| --- | --- |
| Devices | `GET /e2ee/me`, `POST /e2ee/devices`, `GET /e2ee/devices/{device_key}`, `GET /e2ee/profiles/{profile_id}/devices`, `POST /e2ee/devices/lookup`, `POST /e2ee/devices/{device_key}/revoke` |
| KeyPackages | `POST /e2ee/devices/{device_key}/key-packages`, `POST /e2ee/key-packages/claim`, `POST /e2ee/eligibility` |
| Groups | `POST /e2ee/groups`, `GET /e2ee/groups/{group}`, `POST /e2ee/groups/{group}/entries`, `GET /e2ee/groups/{group}/log`, `POST /e2ee/groups/{group}/messages`, `POST /e2ee/groups/{group}/roster`, `GET /e2ee/devices/{device_key}/groups` |
| Welcomes | `GET /e2ee/devices/{device_key}/welcomes`, `POST /e2ee/devices/{device_key}/welcomes/{welcome_id}/ack` |
| Attachments | `POST /e2ee/blobs`, `PUT /e2ee/blobs/{blob_id}/chunks/{index}`, `POST /e2ee/blobs/{blob_id}/complete`, `GET /e2ee/blobs/{blob_id}/chunks/{index}` |
| Reports | `POST /e2ee/reports` |
| Trust and safety | `GET /e2ee/trust-and-safety/reports`, `GET /e2ee/trust-and-safety/reports/{report_id}`, `POST /e2ee/trust-and-safety/reports/{report_id}/hold` (not gated by `E2EE_DMS_ENABLED`, so stored reports stay reviewable) |

## What the server stores

All tables are new (`e2ee_` prefix), created by `dbMigrationsLoop` entity
synchronization, without foreign keys.

| Table | Contents |
| --- | --- |
| `e2ee_devices` | Device key, owner profile, the signed grant fields, `grant_id`, wallet signature, `verified_via`, label, platform, timestamps, revocation (revoker key, signed time, Ed25519 signature) |
| `e2ee_key_packages` | Opaque KeyPackage bytes per device, last-resort flag, expiry |
| `e2ee_groups` | Random group handle `g`, current epoch, current commit key `pub(K_epoch)`, last sequence number |
| `e2ee_report_access_log` | Trust-and-safety audit: viewer profile, action (`list`, `read`, `hold`, `release`), report ids, time. No message content |
| `e2ee_group_epochs` | `pub(K_n)` for every epoch n (immutable per epoch) |
| `e2ee_group_roster` | Delivery windows: device key, profile, `joined_epoch`, `removed_epoch` |
| `e2ee_log` | The ordered log: wrapped (encrypted) entries and messages, their declared hashes, commit keys, signatures, roster deltas, epoch fingerprints |
| `e2ee_welcomes`, `e2ee_welcome_deliveries` | MLS Welcome bytes stored once, one pending delivery per target device |
| `e2ee_blobs`, `e2ee_blob_chunks` | Encrypted attachment chunks and their sizes |
| `e2ee_reports` | Message bodies a recipient chose to disclose (severe-harm categories only), the sender's inner signature, `verified`, `on_hold` |
| `e2ee_push_throttle`, `e2ee_rate_counters` | Wake throttle and fixed-window rate counters |

The server never receives plaintext message content, group names, the MLS
member list, or private keys. The one exception is a report: the reporting
recipient deliberately discloses that message's body (`e2ee_reports` above).
It does see: group handles, epoch numbers, padded ciphertext sizes, timing,
which devices and profiles are in each delivery roster, who submitted what
(from the JWT), and notify hints (which roster profiles a sender asked to
wake).

Every byte column holds ciphertext or opaque MLS bytes, except
`e2ee_reports.body`: a report carries the message as the reporting member
decrypted it, by design. Queries touching
`e2ee_*` tables form a private SQL family in `src/db/my-sql.helpers.ts`:
neither statements nor bound values reach slow-query or error logs. The API
logs no ciphertext, Welcome bytes, KeyPackages or notify hints. Nothing in the
AI or content-moderation pipeline reads E2EE data; reports are stored for
human review only.

## Device grants and revocation

`POST /e2ee/devices` rebuilds the grant statement from the signed fields,
checks ciphersuite 79 (`0x004F`), a printable origin of at most 64 characters, minute
alignment, at most 181 days of lifetime, `issued_at` no more than 10 minutes
ahead and `expires_at` in the future. It then recovers the EIP-712 signer
(salt-only domain, no chain id). If that fails and the wallet has code on
Ethereum mainnet, it calls EIP-1271 `isValidSignature(grant_id, signature)`
through `verifyContractWalletSignatureHash`. The grant wallet must map to the
caller's profile. A profile has at most 10 active devices; re-registering an
unrevoked key of the same profile renews its grant.

A revocation is an Ed25519 signature over
`H("6529.MlsDeviceRevoke.v1", target, revoker, uint64 revoked_at)` by the
device itself or another active device of the same profile, with
`revoked_at` within 10 minutes of server time. The server stores it, removes
the device from every delivery roster at the group's current epoch, and
deletes its KeyPackages and pending welcome deliveries. Revocation is
idempotent.

## Ordering rules

- Each group has one sequence (`seq`) shared by entries and messages.
  Writers lock the group row (`select ... for update`) as the first statement
  of their transaction, so sequence assignment, epoch advance and roster
  changes are serialized per group.
- An entry (commit or proposal) for epoch n is accepted only if n is the
  current epoch, its Ed25519 signature verifies under the stored
  `pub(K_n)` over `entry_digest`, `entry_hash = keccak256(data)` and
  `len(data)` is an entry bucket.
- The first valid commit for an epoch wins. A later one gets
  `409 E2EE_EPOCH_CONFLICT` with `current_epoch`. Two database constraints
  back this up: the unique index on `e2ee_log (group_handle, commit_epoch)`
  (set only for commits) and the primary key of `e2ee_group_epochs`.
- A commit advances the epoch and stores `next_commit_key` as `pub(K_n+1)`.
- Application messages are accepted only for the group's current epoch;
  otherwise `409 E2EE_EPOCH_STALE` with `current_epoch`. Content is therefore
  never accepted under a key that a removed member still holds.
- A proposal may only remove devices of the proposer's own profile (a leave).
  Its devices get `removed_epoch = n + 1`, like a commit removal, so they can
  still read the leave proposal and the commit that removes them; they leave
  the current roster at once, so they receive no further WebSocket hints or
  wakes and cannot send. At most 64 proposals per epoch.
- `roster_add` devices must be active. A profile that is new to the roster
  must pass the caller's policy (below); otherwise the whole entry is
  rejected with `E2EE_POLICY` or `E2EE_BLOCKED`.
- Roster repair (`POST .../roster`) replaces the roster with the members'
  MLS view; it is signed by `K_epoch` over the sorted device keys. Removals
  take effect at the current epoch. A repair cannot re-add a device whose last
  roster row ended with its own profile's leave proposal, or a device of a
  profile that left and has no device in the roster, unless the requester is
  that profile (`403 E2EE_FORBIDDEN`); the members must commit the removal
  instead. Each roster row records how it ended (`commit`, `leave`, `revoke`
  or `repair`).

## Delivery windows

A device reads log items whose epoch lies in one of its roster windows
`[joined_epoch, removed_epoch)`. A commit that adds a device sets
`joined_epoch = n + 1`, so the adding commit itself is excluded; a removing
commit sets `removed_epoch = n + 1`, so the removed device still sees the
commit that removed it but nothing later. A device that was never in the
roster gets `404 E2EE_NOT_MEMBER`, whether or not the group exists.

## Policy

For "caller adds or claims target" (claims, eligibility, `roster_add` of new
profiles, roster repair additions): a block in either direction gives
`BLOCKED`; then the target's DM policy (`EVERYONE`, `PEOPLE_I_FOLLOW` meaning
the target follows the caller, `NOBODY`); then `NO_DEVICES` when the target
has no active device. The facts come from four set-based queries regardless
of the number of targets. A claim with `group` skips blocks and policy for
profiles already in that group's roster, provided the claimer device is in it
too; the caller's own profile always skips them.

## Limits and quotas

| Limit | Value |
| --- | --- |
| Active devices per profile | 10 |
| Unclaimed one-time KeyPackages per device | 100 (`409 E2EE_KEY_PACKAGE_LIMIT` beyond) |
| KeyPackage size | 8 KiB (an X-Wing KeyPackage is about 2.7 KiB) |
| Entry data | an entry bucket, at most 2 MiB |
| Entry plus Welcome plus ratchet tree | 3.25 MiB raw together (the request stays under the 5 MB JSON limit); the Welcome gets what the entry leaves, at least 1.25 MiB |
| Message data | a message bucket, at most 64 KiB |
| Attachment | at most 25 chunks of 1 MiB plaintext (each chunk at most 1 MiB + 16 bytes of ciphertext) |
| Attachment storage per uploading profile | 200 MiB declared bytes per rolling 24 h (`429 E2EE_RATE_LIMITED`), 1 GiB live (`413 E2EE_TOO_LARGE`) |
| Log and welcome ciphertext per profile | 256 MiB per UTC day (`429`) |
| Messages | 120 per minute per device |
| Entries | 12 per hour per group in production, 30 on staging, or `E2EE_ENTRIES_PER_GROUP_PER_HOUR` (counted after the commit-key signature verifies) |
| Roster repairs | 60 per hour per group |
| Claims | 120 per hour per caller profile; 30 per hour per target device (over the device limit, only its last-resort KeyPackage is returned) |
| Group creations | 200 per day per profile |
| Attachment uploads | 100 per day per profile |
| Eligibility checks | 600 per hour per profile |
| Reports | 100 per day per profile |

Rate limits are fixed-window counters in `e2ee_rate_counters` (works without
Redis and in every Lambda instance). Reads use the primary pool so ordering
checks never act on replica lag.

## Storage of attachments

In v1, encrypted attachment chunks are stored in MySQL (`e2ee_blob_chunks`).
The quotas above bound that footprint, uploads may not exceed their declared
size, and blob retention runs on every attachment upload (five expired or
abandoned blobs per pass, chunks and row deleted together) in addition to the
general opportunistic pruning.

Moving ciphertext blobs to a private S3 bucket (or to content-addressed
pinning, P51 DN9) is the first storage follow-up. The API does not change:
clients only ever upload and download opaque ciphertext chunks through
`/e2ee/blobs/...`, so the HTTP API stays compatible. On the server the move
changes the chunk write, read and prune paths in `src/e2ee/e2ee.db.ts` to an
object store, makes `e2ee_blob_chunks.data` optional in favor of an object
key, and deletes objects together with their rows in retention.
`E2EE_ATTACHMENTS_ENABLED=false` is the kill switch meanwhile.

## Retention

Pruned opportunistically by the API (about one write in 100, batches of at
most 100 rows), with no new Lambda: messages after 90 days, entries after 180
days, welcome deliveries after 30 days (and the welcome once no delivery
remains), complete attachments after 365 days and incomplete uploads after
24 hours, KeyPackages at expiry, revoked devices 365 days after revocation,
rate counters after 2 days, wake throttle rows after 1 day, and reports
after 180 days unless trust and safety placed them on hold. Group, epoch
key and roster rows (small delivery metadata) are kept, and so is the report
access log, which holds ids only.

## Reports and trust and safety

Reports are for severe or illegal harm only. `reason` must be one of
`CHILD_SEXUAL_ABUSE_MATERIAL`, `CREDIBLE_THREAT_OF_VIOLENCE`,
`NON_CONSENSUAL_INTIMATE_IMAGERY` or `DOXXING`. Ordinary moderation of
encrypted conversations is out of scope by design: there is no scanning and
no moderator key. Blocking people, leaving or muting chats and the "Who can
message you" setting are the everyday tools.

- A report carries only the one message the reporter selected, its body as
  they decrypted it, and the sender's inner device signature, which the API
  verifies (`verified`). Nothing else in the conversation is revealed.
- Reports are stored in `e2ee_reports`. They never reach wave moderators or
  an AI provider, and no log, wave or notification carries their content.
- The content moderators review them: the same people, with the same check
  (`isModerationDeveloper`, membership in the 6529 Dev Team group), as the
  content-moderation queue, and in the same place (an "Encrypted reports" tab
  on `/content-moderation`). Members of the group named by
  `E2EE_TRUST_AND_SAFETY_GROUP_ID`, when it is set, may also read them. They
  use the trust-and-safety routes (newest first, paged by `before` plus
  `before_id`, so reports sharing a timestamp are never skipped or repeated)
  and can place a report on hold so retention keeps it. Every list, read,
  hold and release is written to `e2ee_report_access_log` (viewer, action,
  report ids, time) before the response is sent; a hold change and its log
  row commit in one transaction. Proxies are rejected.
- Anyone else gets `403 E2EE_FORBIDDEN` ("Moderator access is required").

## WebSocket hints and push wakes

After a transaction commits, the API sends best-effort WebSocket frames to the
primary connections of the affected profiles. Failures never fail the request.

| Type | Data | Recipients |
| --- | --- | --- |
| `E2EE_GROUP_EVENT` | `{ group, seq, epoch, type, item? }`, `item` only when it serializes to at most 16 KiB | Roster profiles (for entries, before and after the change) |
| `E2EE_WELCOME` | `{ device_key, welcome_id, group }` | Target device's profile |
| `E2EE_DEVICE_ADDED` | `{ profile_id, device_key }` | Owner and profiles sharing a roster |
| `E2EE_DEVICE_REVOKED` | `{ profile_id, device_key }` | Owner and profiles sharing a roster |
| `E2EE_ROSTER_CHANGED` | `{ group, epoch }` | Roster profiles after a repair |

Content-free wakes use the existing `firebase-push-notifications` queue with
the message `{ "type": "e2ee_wake", "profile_ids": [...], "reason":
"message" | "added" }`. `pushNotificationsHandler` sends title `6529` and body
`New encrypted message` or `You were added to an encrypted chat`, no image,
and data `{ redirect: "e2ee", target_profile_id, target_profile_handle,
notification_id: "e2ee" }`, without the badge field. It names no sender,
group or text, honours the profile's "Direct messages" notification
preference, and removes unregistered tokens. Wakes are hints and are not
retried after a send. The API sends at most one wake per (profile, group) per
60 seconds; `reason: "added"` goes to profiles new to a roster, `message` to
notify-hinted roster profiles other than the sender.

## Residual powers of 6529.io as orderer

Encryption keeps content away from the server, but the orderer keeps real
powers until the log moves to the chain:

- It can stall or refuse to sequence key changes and messages, and it can
  deny service outright.
- It can withhold or reorder delivery to some members. Members detect this
  through epoch fingerprints (safety codes) and the hash-chained log.
- It sees group metadata: which groups exist, roster device and profile ids,
  join and leave times, group sizes, activity timing, notify hints and IP
  addresses.
- It maps wallets to profiles and handles. A substitution there could present
  an attacker's device as a known person; members see wallet addresses and
  safety codes to check.
- It cannot read content, forge membership changes, or add a device: commits
  must be signed by the epoch commit key that only members can derive, and
  every leaf needs a wallet-signed grant that members verify themselves.

The MLS implementation lives in the clients (OpenMLS). No public third-party
audit of OpenMLS exists; the owner decided to ship without one (D110). Pinned
versions and OpenMLS security advisories are the safeguard.

## Implementation choices

- The welcome acknowledgement schema `ApiE2eeAck` carries an optional
  `acknowledged` field so the generators emit a model; the server returns
  `{}`.
- Creating a group that already exists returns the record when the request
  is an identical retry by the creator; otherwise it is `409
  E2EE_EPOCH_CONFLICT`.
- `E2EE_KEY_PACKAGE_LIMIT` (409) and `E2EE_FORBIDDEN` (403, proxies, callers
  without a profile, proposals removing others, repairs undoing a leave,
  non-uploader blob writes) and `E2EE_BAD_REQUEST` (400, malformed input) are
  additional codes.
- Proposal removals use `removed_epoch = n + 1` (contract v1 said `n`), at the
  request of the client engine, so leavers can read their leave and its
  commit.
- `POST /e2ee/devices/lookup` (`ApiE2eeDeviceLookupRequest` with
  `profile_ids` up to 200 and `device_keys` up to 500, answering
  `ApiE2eeDeviceLookupResponse { devices }`) is an addition to contract v1 so
  clients can verify a whole group's grants in one request.
- A report is stored even when its signature fails; `verified` is true only
  when the sender's inner signature verifies and the sender device was in the
  group's roster at some point.

## Deployment

Deploy `dbMigrationsLoop` first (creates the tables), then
`pushNotificationsHandler` (understands `e2ee_wake` before anyone sends it),
then `api`. The frontend follows the API.
