# Wallet Auth Session V2 Migration Plan

Revision: June 2026

This is the deploy runbook for wallet auth session v2. The rollout keeps v1
refresh available during a grace period so existing users are not logged out,
but new v2 sessions are created only by a v2 structured signature or by
connection sharing from an already-v2 session.

## Target Shape

- Production web keeps calling `https://api.6529.io` directly from
  `https://6529.io`.
- Staging web keeps calling `https://api.staging.6529.io` directly from
  `https://staging.6529.io`.
- Web session v2 uses backend-owned HttpOnly cookies: a compatibility
  `6529_session` cookie plus address-scoped `6529_session_<address-hash>`
  cookies. Current web clients send `client_address` on refresh/logout so
  multi-account sessions target the active wallet instead of whichever account
  last wrote the compatibility cookie.
- Native session v2 uses the native refresh token in secure storage.
- External API clients are not blocked by browser CORS allowlists. Browser
  credentialed CORS remains narrow only on cookie-backed web auth routes.
- Legacy refresh remains a temporary grace-period bridge. It preserves the role
  bound to the legacy refresh token instead of trusting a new client-supplied
  role.
- 6529 Desktop remains on legacy auth during this rollout. Desktop connection
  sharing uses the legacy refresh-token handoff until a separate desktop v2 auth
  release is available.

## Phase 0: Pre-Deploy Config

Set or verify these before the backend silent release.

Required:

- `AUTH_SESSION_HASH_SECRET`: set on the backend API service to a dedicated
  high-entropy secret. The code can fall back to `JWT_SECRET`, but production
  should use a separate value. Set this before any v2 sessions are created;
  rotating it later invalidates existing v2 web cookies, native refresh tokens,
  and unredeemed connection-share codes because those values are stored as
  keyed hashes.

Recommended, not required when the default domains match:

- Production backend API: `WEB_APP_ORIGIN=https://6529.io`.
- Staging backend API: `WEB_APP_ORIGIN=https://staging.6529.io`.

Defaults if `WEB_APP_ORIGIN` is unset:

- Requests served by `api.6529.io` allow credentialed web auth from
  `https://6529.io`.
- Requests served by `api.staging.6529.io` allow credentialed web auth from
  `https://staging.6529.io`.
- Localhost API hosts allow common localhost frontend ports.
- Session-v2 signable messages use the accepted request API host as `Audience`
  when the request is served through `api.6529.io` or `api.staging.6529.io`.
  If the request host is not accepted, the backend falls back to `API_BASE_URL`
  and then `api.6529.io`.

Additive origin config:

- `WEB_APP_ADDITIONAL_ORIGINS`: comma-separated extra web origins to add to the
  defaults and `WEB_APP_ORIGIN`. Use this for previews or temporary first-party
  web origins.

Do not set these yet for a silent release:

- `SESSION_V2_MIGRATION_DEADLINE`: leave unset.
- `AUTH_STRUCTURED_SIGNATURES_REQUIRED`: leave unset or `false`.
- `AUTH_LEGACY_REFRESH_DISABLED`: leave unset or `false`.

## Phase 1: Backend Silent Release

Deploy backend first. This should not force users to sign again and should not
break existing v1 refresh sessions.

Backend services, in order:

1. `dbMigrationsLoop`: required for entity sync / nullable auth-session schema
   changes.
2. `api`: required for auth routes, settings, CORS, session-v2, and legacy
   refresh behavior.

Backend env for this phase:

- `AUTH_SESSION_HASH_SECRET`: required production hardening.
- `WEB_APP_ORIGIN`: recommended explicit value, but defaults cover
  `api.6529.io` and `api.staging.6529.io`.
- `AUTH_CONNECTION_SHARING_DISABLED`: unset or `false`; connection sharing is
  enabled by default.
- `AUTH_LEGACY_REFRESH_DISABLED`: unset or `false`; legacy refresh must remain
  available during the grace period.
- `AUTH_STRUCTURED_SIGNATURES_REQUIRED`: unset or `false`; legacy signatures
  must remain accepted until clients are verified.
- `SESSION_V2_MIGRATION_DEADLINE`: unset; this keeps FE migration prompts
  silent.
- `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED`: unset or `true` until websocket clients
  have moved off query-token auth.

Backend checks after deploy:

- Confirm `dbMigrationsLoop` completed successfully and the production schema
  has `wallet_auth_sessions`, `wallet_connection_shares`, and nullable
  `refresh_tokens.role` before serving v2 auth traffic from `api`.
- `/api/settings` returns `auth.structured_signatures_required=false`.
- `/api/settings` returns `auth.session_v2_migration_deadline=null`.
- `POST /api/auth/redeem-refresh-token` still works for valid legacy refresh
  tokens.
- `POST /api/auth/connection-share/legacy-desktop` works only from an
  authenticated session-v2 web session and returns a legacy desktop
  `/accept-connection-sharing?token=...&address=...` path.
- V2 web auth routes return exact credentialed CORS for the real web origin and
  reject unrelated browser origins.
- Multi-account web refresh/logout preserve account isolation: sign A and B into
  v2, let the compatibility cookie point at B, then refresh/logout A by
  `client_address` without rotating or revoking B.
- If this scoped-cookie behavior is deployed over earlier session-v2 web
  sessions, each already-signed account may need one fresh v2 sign-in to seed
  its address-scoped cookie.

## Phase 2: Frontend And Native Silent Release

Deploy the web frontend after the backend silent release. If the native app is
packaged or released through a separate pipeline, publish the corresponding
native client build before any cutoff phases. 6529 Desktop is not part of this
phase and remains on the existing legacy auth build.

Frontend env:

- Production: `API_ENDPOINT=https://api.6529.io`.
- Staging: `API_ENDPOINT=https://api.staging.6529.io`.

No frontend credential-origin env is required. The FE sends session-v2
credentials to the configured `API_ENDPOINT`.

Frontend targets:

- Production web: `https://6529.io` Elastic Beanstalk app.
- Staging web: `https://staging.6529.io` EC2/pm2 app.
- Native app clients: iOS and Android builds that include session-v2 native
  refresh storage and connection-share redemption.
- 6529 Desktop app: unchanged legacy build. It must continue to receive
  connection-share links with `token`, `address`, and optional `role` query
  parameters.

Checks after deploy:

- New web login creates a v2 session.
- Web refresh and logout work through the API domain for one account and for
  A/B/A multi-account switching after the active JWT has expired.
- Native login, refresh, logout, and connection-share redeem work on current
  iOS and Android builds, or on the native release candidates that will be
  available before cutoff.
- Existing v1 web sessions are not immediately logged out.
- Connection sharing create/redeem works from an active session-v2 web session.
  Legacy-authenticated web users should be prompted to update authentication
  before they can create a share.
- Desktop connection sharing from a v2 web session creates a legacy desktop
  link and the current Desktop app can accept it through legacy refresh-token
  redemption.
- A connection-share QR is an end-to-end test only when the receiver is a native
  client or native release candidate with the session-v2 accept flow. A staging
  web build without the frontend session-v2 changes is not a valid receiver
  test for connection-share redemption.

## Phase 3: Start Migration Prompt

After backend and frontend are both deployed and basic v2 auth is verified, set:

- `SESSION_V2_MIGRATION_DEADLINE=<ISO timestamp with timezone>`.

This is a backend API env change only. It updates `/api/settings.auth` so the FE
can prompt and later enforce v2 migration without another FE release.

Use a future timestamp that leaves enough grace for:

- active web users to sign a v2 auth message;
- native users to establish native v2 sessions;
- external-client operators to receive the cutoff plan.

## Phase 4: Strict Structured Signatures

After web, native, and known external clients are verified with structured
signatures, and after native release candidates are available to users, set:

- `AUTH_STRUCTURED_SIGNATURES_REQUIRED=true`.

This blocks legacy/unstructured signing paths where structured verification is
used. It is not the same as removing legacy refresh: clients that already hold
valid legacy refresh tokens can still refresh until `AUTH_LEGACY_REFRESH_DISABLED`
is set.

## Phase 5: Legacy Refresh Shutdown

After the grace period, support monitoring, native client availability, and
external-client communication are complete, and after 6529 Desktop has shipped
session-v2 auth or no longer needs legacy connection sharing, set:

- `AUTH_LEGACY_REFRESH_DISABLED=true`.

This makes `/auth/redeem-refresh-token` return a deliberate `410 Gone` response
without removing the route. It also disables the legacy desktop connection-share
bridge. At this point v1 refresh clients must sign into v2 or use a supported
v2 flow.

Remove the v1 refresh endpoint/code in a later cleanup only after traffic is
zero and rollback is no longer needed.

## Optional Controls

- `WEB_APP_ADDITIONAL_ORIGINS`: add temporary first-party web origins without
  changing defaults.
- `AUTH_SIGNATURE_ALLOWED_DOMAINS`: add exact first-party structured-signature
  domains not covered by web app origin config or existing defaults.
- `AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES`: add a suffix such as
  `staging.6529.io` when a controlled set of subdomains should be accepted.
- `AUTH_SIGNATURE_ALLOWED_AUDIENCES`: add accepted verification audiences when
  rotating or supporting more than one API audience.
- `AUTH_WALLET_CHAIN_ID`: leave unset for Ethereum mainnet unless intentionally
  testing another supported auth chain.
- `AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS`: leave unset for the default short
  TTL, or set a positive integer such as `300`.
- `AUTH_CONNECTION_SHARING_DISABLED=true`: emergency kill switch for
  mobile/native connection sharing and the legacy desktop bridge. Missing/false
  means connection sharing is enabled.
- `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED=false`: final websocket query-token
  cleanup after web/mobile clients no longer require it.

## Migration Policy

Do not silently convert v1 refresh tokens into v2 sessions. Users should migrate
through one of these paths:

- sign the v2 structured auth message; or
- use connection sharing from an already-v2 authenticated session.

This keeps the v2 session model clean: every v2 session is created by a v2
signature or by a v2-authenticated connection-sharing flow.
Connection-share URLs carry the one-time code and address only; the server
stores and returns the role associated with the share.

Desktop connection-share URLs are the temporary exception while Desktop remains
legacy: they carry a legacy refresh `token`, `address`, and optional `role`, and
are redeemed by the existing Desktop legacy auth flow.

## Rollback

- If web v2 cookie refresh fails, unset `SESSION_V2_MIGRATION_DEADLINE` and keep
  `AUTH_STRUCTURED_SIGNATURES_REQUIRED=false`.
- If credentialed browser CORS is wrong, set or fix `WEB_APP_ORIGIN` /
  `WEB_APP_ADDITIONAL_ORIGINS` on the backend API service. No FE env change is
  required as long as `API_ENDPOINT` points at the intended API.
- If connection sharing causes issues, set
  `AUTH_CONNECTION_SHARING_DISABLED=true`; normal v2 login/refresh remains
  available. This disables both mobile/native connection sharing and the legacy
  desktop bridge.
- If strict signatures are enabled too early, set
  `AUTH_STRUCTURED_SIGNATURES_REQUIRED=false`.
- If legacy refresh is disabled too early, set
  `AUTH_LEGACY_REFRESH_DISABLED=false` or unset it to restore
  `/auth/redeem-refresh-token` and legacy desktop connection sharing without a
  code deploy.
- If v2 auth must be paused after FE deploy, v1 refresh remains available while
  strict mode is off and `AUTH_LEGACY_REFRESH_DISABLED` is not true.
