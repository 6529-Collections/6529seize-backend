# Wallet Authentication

Revision: November 2026

This document describes the current wallet authentication contract and the
session-v2 flow. Web session challenges use ERC-4361 Sign-In with Ethereum
(SIWE), while native and desktop clients retain the 6529 structured-signature
format. The auth system intentionally keeps legacy endpoints stable. The API
contract is unchanged. Session and grant registration records are nullable
columns added by `dbMigrationsLoop` entity synchronization; no data migration
is required.

## Compatibility Model

Existing clients can continue to use the legacy endpoints without code changes:

- `GET /api/auth/nonce`
- `POST /api/auth/login`
- `POST /api/auth/redeem-refresh-token`

Those endpoints remain the compatibility boundary. The revised auth contract does not force existing clients onto structured signatures, cookie sessions, native session refresh, or connection sharing.

New clients should use the session-v2 endpoints:

- `GET /api/auth/session-nonce`
- `POST /api/auth/session-login`
- `POST /api/auth/session-refresh`
- `POST /api/auth/session-logout`

Connection sharing is a separate optional flow:

- `POST /api/auth/connection-share`
- `POST /api/auth/connection-share/legacy-desktop`
- `POST /api/auth/connection-share/redeem`

## Legacy Flow

`GET /api/auth/nonce` keeps the legacy request shape. It accepts `signer_address` and optional `short_nonce`, then returns a nonce and server signature. Clients pass `server_signature` back unchanged. It is a JWT whose payload names the challenge type (`legacy_nonce`) and the text to sign, and it expires after `AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS` (five minutes by default).

`POST /api/auth/login` verifies the signed nonce, resolves the optional role/proxy identity, returns a JWT access token, and returns the legacy refresh token from `refresh_tokens`. Each plain-text challenge signs in once: it is consumed in the same Redis store as structured nonces and, like them, is refused when that store is unavailable outside local and test runs. Builds before November 2026 signed the text itself as the JWT payload, without an expiry. Such a challenge is accepted once during a 15-minute transition that starts when the first API instance of the new build starts (shared through Redis; nothing to configure), and never from 2026-11-17T00:00Z (UTC). Structured messages from `/auth/session-nonce` keep working on `/auth/login` with their own expiry and single use. An old-form challenge is refused before its wallet signature is checked once the transition or that day has passed. Usage is reported as the EMF metric `6529/Auth` `LegacyAuthCalls` by route, challenge format, coarse client family and outcome, and by route and refusal reason (`Refusal`: `none` when accepted, `form_closed` for an old-form challenge refused because its transition or last day has passed, `other` for any other refusal); an alarm can watch `Route=login, Refusal=form_closed`. The refresh-token row stores the server-resolved role from the signed login so future refreshes continue the same legacy session role instead of accepting a new client-selected role.

`POST /api/auth/redeem-refresh-token` redeems the legacy refresh token for a fresh JWT access token. It remains enabled while legacy clients are supported. Refresh preserves the role already bound to that refresh token. If an existing production refresh token has no bound role yet, the first refresh that supplies a role validates it server-side and binds it to that token; later refreshes must match the bound role. Unbound refreshes without a requested role return a wallet-only JWT.

## Session V2 Nonce

`GET /api/auth/session-nonce` returns a backend-generated message in
`signable_message` and an opaque server-signed challenge token in
`server_signature`. The request and response shapes are unchanged.

For web clients:

- `client_type` defaults to `web`.
- The request must include an exact allowed `http` or `https` `Origin`.
- The API rejects Origins containing credentials, non-root paths, queries, or
  fragments instead of silently canonicalizing them.
- The backend derives the SIWE scheme, domain, and URI from that validated
  Origin; clients cannot supply them.
- The SIWE header explicitly includes the Origin scheme and authority,
  including a non-default port.
- The SIWE URI equals the exact normalized frontend Origin, not the API origin.
- The wallet address is emitted in EIP-55 checksum form.
- SIWE `Version: 1` is the ERC-4361 message version. It is independent from
  6529's structured-signature/session protocol version.
- The backend issues a 128-bit hexadecimal nonce and a required five-minute
  expiration.
- Cross-origin browser clients must also be allowed by the web app origin
  configuration so the API can return exact credentialed CORS headers.

For native clients:

- The client must request `client_type=native`.
- The structured message uses `Domain: native`.
- The structured message uses `Session Type: native`.
- No browser client origin is included.
- The `Purpose` line says that 6529.io never asks for this message in a web
  browser, only the 6529 Mobile app and API clients do. Clients sign the
  returned text as is; desktop challenges keep the shorter purpose.

For 6529 Desktop clients:

- The client must request `client_type=desktop`.
- The structured message uses the normalized localhost host as `Domain`.
- The structured message includes `Client Origin` for that localhost app origin.
- The structured message uses `Session Type: desktop`.

`chain_id` is accepted for backward-compatible request shape, but wallet auth challenges are issued for the backend-configured auth chain. `AUTH_WALLET_CHAIN_ID` defaults to Ethereum mainnet.

For new web SIWE challenges, `server_signature` is a versioned HS256 JWT
envelope. It binds the exact SIWE message, web client type, normalized frontend
Origin, allowed API audience, issuer, subject, issued-at time, and expiration.
The API request Host must resolve to an allowed API audience; the SIWE path does
not substitute the production audience for a malformed or unrecognized Host.
This envelope is the server-issuance proof. The Redis nonce record is created
only when a fully verified login consumes the challenge, and then prevents that
server-authenticated challenge from being used again. Clients must treat the
token as opaque.

Native and desktop challenges continue to use the previous signed-string token.
The login endpoint also accepts valid outstanding `first_party_web` structured
challenges issued before the SIWE deployment, subject to their existing
five-minute expiration and message-level allowed-audience validation. These
compatibility challenges do not acquire the new current-Host JWT audience check.
The nonce endpoint does not issue new legacy web challenges.

## Session V2 Login

`POST /api/auth/session-login` verifies the server challenge and wallet
signature without changing the request or response contract. SIWE is treated as
a strongly structured authentication format even when
`AUTH_STRUCTURED_SIGNATURES_REQUIRED=true`.

For web sessions:

- New challenges must be canonical ERC-4361 SIWE with Version 1, the fixed 6529
  sign-in statement, the expected checksummed address, configured chain,
  normalized Origin scheme/domain/URI, and five-minute lifetime.
- The request `Origin` must match both the SIWE URI and the Origin bound into the
  server envelope.
- The request `Origin` must be allowed by the web app origin configuration when the browser calls the API cross-origin with cookies.
- Valid outstanding structured web challenges still require
  `Session Type: first_party_web` and their signed `Client Origin`.
- The server creates a row in `wallet_auth_sessions` with `client_type=web`.
- The stored session includes the signed domain and normalized client origin.
- The refresh secret is stored only as a server-side hash.
- The browser receives an HttpOnly compatibility `6529_session` cookie and an
  HttpOnly address-scoped `6529_session_<address-hash>` cookie scoped to
  `/api/auth`. The compatibility cookie preserves older web-client behavior;
  the scoped cookie lets multi-account web sessions refresh, logout, and create
  connection shares for the intended active wallet.

For native and desktop sessions:

- The signed message must match the requested `client_type`:
  `Session Type: native` for native or `Session Type: desktop` for desktop.
- The server creates a row in `wallet_auth_sessions` with `client_type=native`
  or `client_type=desktop`.
- The refresh token is returned in the JSON response.
- The refresh token is stored only as a server-side hash.

Both web and native session login return a JWT access token and access-token expiry.

EOA wallet signatures continue to use ERC-191 personal-sign verification.
Contract wallets and Safes continue to use EIP-1271 on
`AUTH_WALLET_CHAIN_ID`. Every address, chain, client-type, domain, URI, Origin,
audience, and timing check completes before the signature is accepted. The
nonce is then consumed as a separate final atomic operation using Redis
`SET NX EX`; repeated or concurrent use is rejected. Local/test can use the
in-memory fallback, while production fails closed when Redis is unavailable.

## Device Signing Grants

Web SIWE logins can also grant a browser-held, non-extractable Ed25519 device
key the right to sign drop writes for 180 days. Unsigned writes and logins
without device parameters are unchanged.

- `GET /api/auth/session-nonce` accepts optional `device_key` (`0x` + 64
  lowercase hex), `device_key_type=ed25519` (required with a key) and
  `device_scopes` (comma list from `post,edit,delete,react,vote`, default
  `post,edit,delete,react`, must include `post`). Any device parameter with a
  native or desktop client type returns 400.
- The SIWE message then carries exactly one resource
  `urn:6529:device-grant:v1:ed25519:{key hex}:{scopes joined by .}:{expiry}`
  and a statement rendered from it. The expiry is the issuing minute plus 180
  days. For the default scopes the statement reads:

  > Sign in to 6529 and turn on signed messages on this device until 29 Apr 2027. This device will sign your posts, edits, deletes and reactions so
  > anyone can verify they came from your wallet. It can't move funds, change
  > your handle, add devices or act as an admin. No transaction, no gas, no
  > token approvals. (Device key 65942d9f...d8128d49)

  It is one ASCII line. The date is the expiry's UTC calendar date as
  `D Mon YYYY` (English month abbreviations); the exact expiry time is only in
  the URN. The scope list names what the device signs (`post` posts, `edit`
  edits, `delete` deletes, `react` reactions, `vote` votes) joined as an
  English list, and the key is its first and last 8 hex characters joined by
  `...`. The parser accepts only the plain sign-in message or this exact grant
  shape (one URN, canonical scopes, minute-aligned expiry at most 181 days
  after Issued At, and the statement rendered from that URN). It also accepts
  the statement of grants issued before this wording ("Sign in to 6529 and let
  this device post as you until {expiry minute} UTC (device key {key}). It may
  {scopes}. ..."), so a challenge issued just before a deploy still logs in;
  grants signed over it stay valid. The frontend must accept a new statement
  shape before the backend renders it.

- Combined grant (NC8): with `mls_device_key` (`0x` + 64 lowercase hex, not
  the signing key) and `mls_ciphersuite` as well, the same message also grants
  the browser's MLS signature key for end-to-end encrypted messages. It then
  carries two resources in this order, the signing URN above and
  `urn:6529:mls-device-grant:v1:{ciphersuite}:{MLS key hex}:{expiry}` with
  the same expiry, and a combined statement that adds one clause and the
  second key to the signed-messages statement:

  > ... so anyone can verify they came from your wallet. It will also
  > encrypt (send) and decrypt (read) your end-to-end encrypted messages,
  > which 6529.io cannot read. It can't move funds, ... (Device key
  > d75a9801...f707511a, encrypted messages key 3d4017c3...2af4660c)

  The server issues it only while encrypted messages are on, the
  ciphersuite is its own (`E2EE_CIPHERSUITE`) and the signer wallet already
  has a profile (`identitiesDb.getProfileIdByWallet`, the lookup encrypted
  messages device registration uses); otherwise it ignores the MLS
  parameters and issues the signing grant alone. A new wallet therefore
  never signs an encrypted-messages grant it could not use: the MLS device
  can only join a profile, so the client enrolls it with its own grant
  prompt after the profile exists. The profile lookup runs only after the
  E2EE flag and ciphersuite checks pass. The parser accepts exactly
  the plain sign-in, the one-resource signing grant (current or legacy
  statement) and this two-resource shape with a combined statement from the
  list in `combined-device-grant.ts`; resources out of order, a third
  resource, a different MLS expiry, the signing key reused as the MLS key or
  a mismatched statement fail closed. The wording is owner-approved;
  to change it, add a renderer at the front of that list (keep the old ones)
  and ship a frontend that accepts it first.

- `POST /api/auth/session-login` stores the grant in `device_grants` only
  after the wallet signature verified and the nonce was consumed, keyed by the
  EIP-191 hash of the exact signed message. The response gains `device_grant`.
  A storage failure is logged and the login still succeeds without it.
  Optional `device_label` is reduced to letters, digits, spaces and `._()-`,
  at most 48 characters, defaulting to `Browser`.
- `GET /api/device-grants` lists the grants of every wallet of the caller's
  profile; `POST /api/device-grants/{grantId}/revoke` revokes one. Neither is
  available to proxies. Revoking a combined grant also revokes the
  encrypted-messages device it enrolled (see `docs/e2ee-messaging.md`).
- `POST /api/device-grants/{grantId}/label` renames an unrevoked signing
  grant owned by one of the caller's profile wallets.
  `POST /api/e2ee/devices/{device_key}/label` renames an owned, unrevoked
  encryption device. The frontend uses the encryption-device label for linked combined
  grant rows, so both permission views display the same server name.
  Labels use the existing server fields, not a local nickname or an additional
  nickname column. Any authenticated browser or app of the owner can rename
  a device; other clients see it when they refresh their lists. Rename and
  revocation use row locking so a concurrent revoke cannot leave stale labels.
- `POST /api/device-grants/{grantId}/acknowledge` records the owner's
  acknowledgment of an active Signed Posts grant. It is idempotent and leaves
  the grant's permissions intact. The authenticated owner sees the state in
  `GET /api/device-grants` from any device. Public signature proofs omit it.
- App device grants (6529 Mobile and 6529 Desktop, whose sign-in is not a
  SIWE web session): `POST /api/device-grants` registers an EIP-712 grant the
  signed-in wallet signed outside sign-in. Domain `6529 Device Grant`,
  version `1`, the pre-genesis salt shared with encrypted-messages grants;
  primary type:

  ```text
  DeviceGrant(string statement, address wallet, bytes32 deviceKey, string scopes, bytes32 mlsDeviceKey, uint16 ciphersuite, uint64 issuedAt, uint64 expiresAt, string origin)
  ```

  A signing-only grant carries
  zero in `mlsDeviceKey` and `ciphersuite`; a combined grant carries the
  encrypted-messages key (different from `deviceKey`) and the current
  ciphersuite, only while encrypted messages are on and only for a wallet
  with a profile. The server renders the statement from the fields
  (`app-device-grant.ts`; the owner-approved wording is part of the signed
  commitment and must remain byte-for-byte compatible with clients) and verifies the signature as an EOA or through
  EIP-1271 on Ethereum mainnet. The grant wallet must be the authenticated
  wallet (no proxies), `issuedAt` within the last day (10 minutes of clock
  skew ahead), the lifetime at most 181 days and `expiresAt` minute aligned.
  The row is stored in `device_grants` like a sign-in grant: the id is the
  EIP-712 digest, `domain` is the grant's `origin`, `chain_id` is 1 and
  `message` is the signed typed-data message as JSON (it starts with `{`, a
  SIWE message never does), so proofs from `GET /drops/{id}/signed-events`
  stay verifiable by anyone. The typed-data domain has no chain id, so a
  verifier rebuilds the digest from the JSON alone; the stored `chain_id` only
  says where an EIP-1271 contract-wallet signature is checked. A
  signing-only grant sends `mls_device_key` and `ciphersuite` as null (or
  omits them); `0` is rejected. Signed writes, expiry and revocation treat it
  exactly like a sign-in grant. Idempotent on grant id.

- Grant origins: after the signature verifies, `POST /api/device-grants` and
  `POST /api/e2ee/devices` compare the signed `origin` with the origins
  recognised for the request's API host: the hosts of the web origins
  credentialed sign-in accepts there (`6529.io` on `api.6529.io`,
  `staging.6529.io` on `api.staging.6529.io`, local hosts on a local API,
  plus `WEB_APP_ORIGIN`, `WEB_APP_ADDITIONAL_ORIGINS` and
  `AUTH_WEB_CREDENTIAL_ORIGINS`) and `6529 Desktop`. Each check writes an
  EMF line `_type: 6529.device_grant_origin.v1` (namespace
  `6529/DeviceGrants`, metric `GrantOriginChecks`, dimensions
  `Route`+`Verdict`, `Route`+`Reason` and `Route`+`ClientType`+`Binding`;
  fields `Policy`, `Decision`, `RequestOrigin`, `RequestOriginKind`,
  `Origin`, `GrantId`, `ApiHost`). `Reason` is `web_origin` or `app_origin`
  when recognised, else `other_environment`, `loopback` or `unrecognized`;
  an unrecognised origin also logs a warning starting
  `[DEVICE GRANT ORIGIN UNRECOGNIZED]`. With
  `DEVICE_GRANT_ORIGIN_POLICY=enforce` such a registration answers 400
  (`Invalid device grant: unrecognized origin`, or the encrypted-messages
  bad-grant error with `unrecognized_origin`); by default it is accepted
  exactly as before. Stored grants are never re-checked.
- Registration records: `device_grants` rows record how the grant was
  registered: `registered_client_type`, `registered_binding` and
  `registered_session_id` (for a sign-in grant: `web`, `siwe` and the web
  session it created; for an app grant: the caller's access-token claims
  below) and `registered_request_origin` (the request `Origin`, normalized;
  another scheme such as an app web view's is kept lowercased). Each is null
  when unknown, including for grants stored before these columns existed.
  The API response shape is unchanged.

- `POST /drops`, `POST /drops/{id}`, `DELETE /drops/{id}` and
  `POST|DELETE /drops/{id}/reaction` accept an optional `device_signature`
  (`grant_id`, `seq`, `claimed_time`, `signature`). The server strips it from
  the body, rebuilds the EIP-712 interim event (kind, stored wave, refs,
  canonical-JSON body hash), checks the grant (scope, expiry, revocation,
  wallet of the acting non-proxy profile), the 10-minute clock window and the
  Ed25519 signature, and reserves the event in `device_signed_events` (unique
  on event id and on device key plus `seq`) before performing the write. A
  failed write releases the reservation. Any check failure returns 400 with a
  message starting `Invalid device signature:` and code
  `INVALID_DEVICE_SIGNATURE`.
- `drop_author_signatures` records which event's body is a drop's current
  content: signed creates and edits set it, unsigned edits and deletes clear
  it. `GET /api/drops/{dropId}/signed-events` returns a readable drop's
  events, the grant proofs they reference and the current event id. When the
  drop read path hides the drop's content from the caller (moderation) or
  shows its author as anonymous (anonymous competition entries), it returns
  the empty result of an unsigned drop instead: signed bodies are the content
  and grant proofs name the author's wallet.
- `GET /api/drops/signed-events?drop_ids=<id,id,...>` (1 to 50 ids) answers
  the same question for several drops at once. Readability, moderation and
  anonymity are decided per drop exactly as for the single route (one
  eligibility-checked query, the same drop mapping, the same anonymity rule);
  ids the caller cannot read, existing or not, are listed in `unavailable`.
  Each readable drop carries only its content events (post, edit, delete), at
  most 20 (the first, the current one and the newest; `truncated_drop_ids`
  lists drops with more), and the grant proofs of all listed events are
  returned once in the top-level `grants`. The drops router hands
  `GET /drops/signed-events` on to the generated routes so it is not read as a
  drop id.
- Every drop the API serializes (`ApiDrop`, `ApiDropWithoutWave` and
  `ApiDropV2`, including websocket drop updates) carries the optional
  `is_author_signed`: true exactly when that drop has a
  `drop_author_signatures` row, the same state as a non-null current event id.
  The mappers read it for a whole page with one primary key lookup. It is
  false when the viewer cannot see the drop's content or its author is
  anonymous. For signed creates, `DropCreationApiService.createDrop` broadcasts
  inside the write callback, before `DeviceSignedWritesService.runReserved`
  finalizes the signature, so the initial live update may report the new drop as
  unsigned. Signed creates and edits refresh the response's author-signature
  status after signed-write finalization. Edits then broadcast that refreshed
  response, so recipients normally get the edited content and author-signature
  status together; unsigned edits clear that status in the live update as well.
  If the post-write signature-status read fails, `withStoredAuthorSignature`
  returns the previously mapped status, which may be stale until a later
  successful read.

## Access Token Claims

Access tokens carry `id`, `sub` (wallet), `exp`, the optional `role` and
these optional session claims:

- `ct`: the session type that minted the token: `web`, `native`, `desktop`,
  or `legacy` for `/auth/login` and `/auth/redeem-refresh-token`.
- `sb`: how the wallet approved the session: `siwe` (origin-checked web
  sign-in), `structured` (6529 structured sign-in text), `share` (redeemed
  connection-share code) or `legacy_text` (plain-text `/auth/login`). It is
  absent for legacy refresh-token redemption and for sessions created before
  `wallet_auth_sessions.signature_format` was recorded.
- `sid`: the `wallet_auth_sessions` id of a session-v2 token.

Refresh keeps `ct` and `sb` from the stored session. No route requires these
claims: tokens without them, or with values a build does not know, verify
and authorize exactly as before. The API reads them into
`AuthenticationContext.accessTokenSession`; clients ignore them.

## Session V2 Refresh And Logout

`POST /api/auth/session-refresh` rotates the session refresh material and returns a fresh JWT access token.

For web sessions:

- Current web clients send `client_address`. The backend checks the matching
  address-scoped cookie first and falls back to the compatibility `6529_session`
  cookie only when that cookie belongs to the same requested address.
- Older web clients without `client_address` keep using the compatibility
  `6529_session` cookie.
- The request `Origin` must match the `client_origin` stored on the session.
- The request `Origin` must be allowed for credentialed web auth CORS.
- The cookie secret is rotated on every successful refresh.
- Concurrent requests that present the same valid cookie receive the same
  rotated credential during a short idempotency window, so response ordering
  cannot desynchronize the browser and server.
- Session validation uses authoritative writer state so a newly rotated secret
  is not rejected because a read replica has not caught up.
- Invalid or mismatched refresh requests return `401` without changing browser
  cookies. Cookie clearing remains an explicit logout or replacement action.

For native and desktop sessions:

- The request supplies `client_address` and `native_refresh_token`.
- The request supplies `client_type=native` or `client_type=desktop`.
- The refresh token is rotated on every successful refresh.

`POST /api/auth/session-logout` revokes the current session by default. Current
web clients send `client_address` so logout targets the matching address-scoped
cookie and does not revoke whichever account last wrote the compatibility
cookie. When `all_sessions=true`, it revokes all wallet auth sessions for the
verified target address and removes that wallet's legacy refresh token, so
older Desktop builds that hold it are signed out as well (the next legacy
sign-in issues a new one). Revoking the sessions is the part that must
succeed: if the legacy refresh token cannot be removed afterwards, the logout
still succeeds and logs `[SIGN_OUT_ALL_LEGACY_REFRESH_TOKEN_NOT_REMOVED]`. A
single-session logout leaves the legacy refresh token in place. Web logout also checks the request `Origin` against the
stored session origin before revoking an existing session.

## Connection Sharing

Connection sharing is not a replacement for refresh-token redemption. It creates an additional authenticated session from an already authenticated session.

The session-v2 mobile/native/desktop flow is:

1. An authenticated client calls `POST /api/auth/connection-share`.
2. The server creates a short-lived one-time `connection_share_code`.
3. The response includes `connection_share_code` and a `deep_link_path`.
4. A native or desktop client calls `POST /api/auth/connection-share/redeem`.
5. The server consumes the share code once and creates the requested native or
   desktop wallet auth session.

The original client remains connected. This is connection sharing, not moving or revoking the original connection.

A share may include opaque `encrypted_device_setup` ciphertext for receiving-app
setup. The server stores and returns that ciphertext without its decryption key;
the frontend carries the key privately in the link fragment. Secure setup is
not available to proxy sessions. Creating the share does not register a signing
grant or encryption device: the receiving app redeems the session, decrypts the
setup and registers the wallet-approved grant. An unused QR therefore leaves no
active device entry. A client can preserve already usable receiver keys/history
instead of registering replacements. The source browser need not enroll itself
to approve another device.

Connection share creation requires bearer JWT auth plus proof that the caller has
an active matching source session for the authenticated wallet and role:

- Web callers prove the source session with the active session-v2 web cookie.
- Native and desktop callers can instead include `client_type`,
  `client_address`, and `native_refresh_token`; the backend checks that refresh
  token against the active source session before issuing a share.

Connection share state is stored in `wallet_connection_shares`. Share codes are
stored only as server-side hashes and expire after a short TTL. Redeeming a
share returns `client_type` so callers can persist the refresh token under the
actual session type created by the backend.

Redemption atomically marks the share consumed, so the same code cannot be
redeemed again. Expiry is checked during redemption. These paths do not
immediately delete the stored share row or its setup ciphertext.

A wallet has at most one live link per target client type and kind (with or
without device setup): creating a share marks the wallet's earlier unconsumed,
unexpired share of the same target and kind consumed, without a session, so
an old QR code or link stops working once its source shows a new one. Retiring
the old share and storing the new one happen in one transaction, so a failed
create leaves the previous link live. A plain
link and a device-setup link for the same target can be live together, so
going back from secure setup to a plain link keeps the plain link valid.
Device-setup links expire after `AUTH_CONNECTION_SHARE_SETUP_TTL_SECONDS`
(default 120 seconds), plain links after
`AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS` (default 300 seconds, clamped to
60-3600).

A redeem records the coarse client family of the redeeming request (for
example `desktop` or `browser`, never the user agent) in
`consumed_client_family`, logs the share id, target and whether device setup
was returned, and emits the EMF metric `6529/Auth` `ConnectionShareRedeems` by
target, outcome and device setup. A source address that sends 20 invalid,
used or expired codes within 10 minutes gets `429` until the window ends; the
counter is kept in Redis under a keyed hash of the address and the limiter is
off when Redis is unavailable.

The desktop compatibility flow remains available for legacy Desktop builds that
still need the legacy refresh-token handoff:

1. A session-v2 client calls `POST /api/auth/connection-share/legacy-desktop`.
2. The server requires bearer JWT auth plus either an active matching
   session-v2 web cookie or the native/desktop source-session proof described
   above.
3. The server returns a legacy refresh token and an
   `/accept-connection-sharing?token=...&address=...` deep-link path.
4. 6529 Desktop redeems that token through `POST /api/auth/redeem-refresh-token`
   and continues using the legacy refresh flow.

This bridge does not add a new origin allowlist for Desktop. It is available
only while both connection sharing and legacy refresh redemption are enabled.

## Configuration

The revised auth flow uses these relevant flags/config values:

- `AUTH_STRUCTURED_SIGNATURES_REQUIRED`: default false. When true, legacy signature verification paths reject unstructured wallet messages where structured verification is used.
- `AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS`: lifetime of new `GET /auth/nonce` challenges. Defaults to 300 seconds; values are clamped to 60-3600 and anything that is not a whole number means the default. Widen it if signers with multi-owner contract wallets cannot finish within five minutes.
- `AUTH_LEGACY_TEXT_LOGIN_DISABLED`: default false. When true, `GET /auth/nonce` answers `410` and `POST /auth/login` refuses plain-text signatures. Structured messages on `/auth/login`, the session-v2 routes and drop, rememe and NextGen signatures are not affected. Turn it on once the `LegacyAuthCalls` metric shows no current client signing in with plain text.
- `DEVICE_GRANT_ORIGIN_POLICY`: default (unset) is log only. `enforce` refuses new app device grants and encrypted-messages device grants whose signed origin is not recognised for the API host (see Device Signing Grants). Any other value is treated as unset and logged once.
- `WEB_APP_ORIGIN`: canonical first-party web app origin. The backend uses it to derive credentialed CORS origins and SIWE domain/URI checks. Values must be exact origins without credentials, a non-root path, query, or fragment.
- `WEB_APP_ADDITIONAL_ORIGINS`: comma-separated extra exact first-party web app origins. These are additive to the built-in defaults and `WEB_APP_ORIGIN`.
- Built-in web app origin defaults: `api.6529.io` allows credentialed web auth from `https://6529.io`; `api.staging.6529.io` allows credentialed web auth from `https://staging.6529.io`; localhost API hosts allow common localhost frontend ports.
- `AUTH_SIGNATURE_ALLOWED_DOMAINS`: comma-separated extra exact domains allowed for first-party web structured signatures. The built-in production domains include `6529.io`, `www.6529.io`, and `app.6529.io`; web app origins also derive allowed signature domains, taken from the request's API host (the web origins credentialed sign-in accepts there), so `api.6529.io` does not accept `staging.6529.io` unless it is configured; non-production also allows localhost origins.
- `AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES`: comma-separated domain suffixes allowed for first-party web structured signatures. A value of `staging.6529.io` allows `staging.6529.io` and any host below it, such as `app.staging.6529.io`, but does not allow lookalike hosts such as `fake-staging.6529.io`.
- Session-v2 nonce audience: new web SIWE envelope tokens require the exact accepted request API Host and fail closed when it is missing, malformed, or unrecognized. Native and desktop structured messages preserve their existing accepted-Host behavior and compatibility fallback.
- `AUTH_SIGNATURE_ALLOWED_AUDIENCES`: optional comma-separated audiences accepted during structured-signature verification.
- `AUTH_WEB_CREDENTIAL_ORIGINS`: deprecated compatibility alias for extra browser origins allowed to call v2 web-auth cookie endpoints with credentials. Prefer `WEB_APP_ORIGIN` and `WEB_APP_ADDITIONAL_ORIGINS`.
- `AUTH_WALLET_CHAIN_ID`: authoritative chain id used for SIWE and structured login authentication. Defaults to Ethereum mainnet (`1`) when unset.
- `AUTH_SESSION_HASH_SECRET`: secret used for hashing session cookies, native refresh tokens, connection share codes, and public user-agent values. Defaults to the JWT secret if unset.
- `AUTH_SESSION_V2_REFRESH_DAYS`: session refresh lifetime in days. Defaults to 30.
- `AUTH_CONNECTION_SHARING_DISABLED`: default false. Set to `true` only to disable `/auth/connection-share`, `/auth/connection-share/legacy-desktop`, and `/auth/connection-share/redeem`; otherwise connection sharing is enabled.
- `AUTH_LEGACY_REFRESH_DISABLED`: default false. Set to `true` only after the configured v2 migration deadline and final shutdown checks to make `/auth/redeem-refresh-token` and the legacy desktop connection-sharing bridge unavailable without removing the endpoints.
- `AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS`: one-time connection share code lifetime. Defaults to 300 seconds; values are clamped to 60-3600 and anything that is not a whole number means the default.
- `AUTH_CONNECTION_SHARE_SETUP_TTL_SECONDS`: lifetime of connection share codes that carry encrypted device setup. Defaults to 120 seconds and is never longer than `AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS`; a missing or non-positive value means the default.
- `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED`: default true. Controls legacy WebSocket JWT query-token support.

There is intentionally no `AUTH_SESSION_V2_ENABLED` flag. Session-v2 endpoints are separate from the legacy endpoints, so exposing them does not change legacy client behavior.

There is intentionally no `AUTH_LEGACY_REFRESH_ENABLED` flag. Legacy refresh redemption stays available while legacy clients are supported, and can later be disabled explicitly with `AUTH_LEGACY_REFRESH_DISABLED=true`.

## Data Model

`wallet_auth_sessions` stores session-v2 refresh state:

- Web sessions store a hashed cookie secret plus signed domain/client-origin metadata.
- Native sessions store a hashed native refresh token. Native and desktop
  sessions created by a structured sign-in also store the signed `Domain`
  and, for desktop, `Client Origin`.
- `signature_format` (`siwe`, `structured` or `share`) and `request_origin`
  (the request `Origin` at sign-in, when sent) are recorded for new
  sessions; older rows keep null.
- Both session types store wallet address, optional role, expiry, last-use time, and revocation time.

`device_grants` stores wallet-signed device signing grants: the exact SIWE
message and wallet signature, wallet, Ed25519 key, scopes, label, domain,
chain, issue, expiry, revocation and last-use times, and the nullable
registration record (`registered_client_type`, `registered_binding`,
`registered_request_origin`, `registered_session_id`).

`device_signed_events` stores every device-signed drop write: the signed event
fields, the canonical body exactly as hashed, the Ed25519 signature, the drop it
applied to (set only after the write succeeded) and the server receive time.
`drop_author_signatures` maps a drop to the event whose body is its current
content.

`wallet_connection_shares` stores one-time connection share state:

- The share code hash.
- Wallet address and optional role to share.
- Target client type.
- Expiry and consumption metadata.
- The native session id created when the share is redeemed (null for a share
  retired by a newer one).
- The coarse client family of the redeeming request.

`refresh_tokens` stores legacy refresh-token compatibility state:

- Wallet address.
- Legacy refresh token.
- Optional server-bound role profile id used only while v1 refresh remains available during migration.
