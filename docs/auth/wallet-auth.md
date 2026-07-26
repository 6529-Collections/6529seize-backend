# Wallet Authentication

Revision: July 2026

This document describes the current wallet authentication contract and the
session-v2 flow. Web session challenges use ERC-4361 Sign-In with Ethereum
(SIWE), while native and desktop clients retain the 6529 structured-signature
format. The auth system intentionally keeps legacy endpoints stable. The API
contract and database schema are unchanged; no database migration is required.

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

`GET /api/auth/nonce` keeps the legacy request shape. It accepts `signer_address` and optional `short_nonce`, then returns a nonce and server signature.

`POST /api/auth/login` verifies the signed nonce, resolves the optional role/proxy identity, returns a JWT access token, and returns the legacy refresh token from `refresh_tokens`. The refresh-token row stores the server-resolved role from the signed login so future refreshes continue the same legacy session role instead of accepting a new client-selected role.

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

- The signed message must have `Session Type: native` or `Session Type:
  desktop`, matching the requested `client_type`.
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
- On invalid or mismatched address-scoped sessions, the response clears the
  scoped cookie for the requested address without clearing another account's
  compatibility cookie.

For native and desktop sessions:

- The request supplies `client_address` and `native_refresh_token`.
- The request supplies `client_type=native` or `client_type=desktop`.
- The refresh token is rotated on every successful refresh.

`POST /api/auth/session-logout` revokes the current session by default. Current
web clients send `client_address` so logout targets the matching address-scoped
cookie and does not revoke whichever account last wrote the compatibility
cookie. When `all_sessions=true`, it revokes all wallet auth sessions for the
verified target address. Web logout also checks the request `Origin` against the
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
- `WEB_APP_ORIGIN`: canonical first-party web app origin. The backend uses it to derive credentialed CORS origins and SIWE domain/URI checks. Values must be exact origins without credentials, a non-root path, query, or fragment.
- `WEB_APP_ADDITIONAL_ORIGINS`: comma-separated extra exact first-party web app origins. These are additive to the built-in defaults and `WEB_APP_ORIGIN`.
- Built-in web app origin defaults: `api.6529.io` allows credentialed web auth from `https://6529.io`; `api.staging.6529.io` allows credentialed web auth from `https://staging.6529.io`; localhost API hosts allow common localhost frontend ports.
- `AUTH_SIGNATURE_ALLOWED_DOMAINS`: comma-separated extra exact domains allowed for first-party web structured signatures. The built-in production domains include `6529.io`, `www.6529.io`, and `app.6529.io`; web app origins also derive allowed signature domains; non-production also allows localhost origins.
- `AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES`: comma-separated domain suffixes allowed for first-party web structured signatures. A value of `staging.6529.io` allows `staging.6529.io` and any host below it, such as `app.staging.6529.io`, but does not allow lookalike hosts such as `fake-staging.6529.io`.
- Session-v2 nonce audience: new web SIWE envelope tokens require the exact accepted request API Host and fail closed when it is missing, malformed, or unrecognized. Native and desktop structured messages preserve their existing accepted-Host behavior and compatibility fallback.
- `AUTH_SIGNATURE_ALLOWED_AUDIENCES`: optional comma-separated audiences accepted during structured-signature verification.
- `AUTH_WEB_CREDENTIAL_ORIGINS`: deprecated compatibility alias for extra browser origins allowed to call v2 web-auth cookie endpoints with credentials. Prefer `WEB_APP_ORIGIN` and `WEB_APP_ADDITIONAL_ORIGINS`.
- `AUTH_WALLET_CHAIN_ID`: authoritative chain id used for SIWE and structured login authentication. Defaults to Ethereum mainnet (`1`) when unset.
- `AUTH_SESSION_HASH_SECRET`: secret used for hashing session cookies, native refresh tokens, connection share codes, and public user-agent values. Defaults to the JWT secret if unset.
- `AUTH_SESSION_V2_REFRESH_DAYS`: session refresh lifetime in days. Defaults to 30.
- `AUTH_CONNECTION_SHARING_DISABLED`: default false. Set to `true` only to disable `/auth/connection-share`, `/auth/connection-share/legacy-desktop`, and `/auth/connection-share/redeem`; otherwise connection sharing is enabled.
- `AUTH_LEGACY_REFRESH_DISABLED`: default false. Set to `true` only after the configured v2 migration deadline and final shutdown checks to make `/auth/redeem-refresh-token` and the legacy desktop connection-sharing bridge unavailable without removing the endpoints.
- `AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS`: one-time connection share code lifetime. Defaults to 300 seconds.
- `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED`: default true. Controls legacy WebSocket JWT query-token support.

There is intentionally no `AUTH_SESSION_V2_ENABLED` flag. Session-v2 endpoints are separate from the legacy endpoints, so exposing them does not change legacy client behavior.

There is intentionally no `AUTH_LEGACY_REFRESH_ENABLED` flag. Legacy refresh redemption stays available while legacy clients are supported, and can later be disabled explicitly with `AUTH_LEGACY_REFRESH_DISABLED=true`.

## Data Model

`wallet_auth_sessions` stores session-v2 refresh state:

- Web sessions store a hashed cookie secret plus signed domain/client-origin metadata.
- Native sessions store a hashed native refresh token.
- Both session types store wallet address, optional role, expiry, last-use time, and revocation time.

`wallet_connection_shares` stores one-time connection share state:

- The share code hash.
- Wallet address and optional role to share.
- Target client type.
- Expiry and consumption metadata.
- The native session id created when the share is redeemed.

`refresh_tokens` stores legacy refresh-token compatibility state:

- Wallet address.
- Legacy refresh token.
- Optional server-bound role profile id used only while v1 refresh remains available during migration.
