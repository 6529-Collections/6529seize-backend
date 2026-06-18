# Wallet Auth Session V2 Migration Plan

Revision: June 2026

This plan covers the production and staging rollout for wallet auth session v2.
It keeps v1 auth available during a grace period so existing users are not
logged out, but requires users to migrate by signing a v2 structured auth
message or using connection sharing from an already-v2 session.

## Target Architecture

- Web app continues to call the public API domain directly:
  - production web: `https://6529.io`
  - production API: `https://api.6529.io`
  - staging web: `https://staging.6529.io`
  - staging API: `https://api.staging.6529.io`
- Browser web auth uses the backend-owned HttpOnly `6529_session` cookie.
- Native auth uses the v2 native refresh token in secure storage.
- External API clients keep using public API auth flows and are not gated by
  browser CORS origin allowlists.
- Legacy refresh remains available only as a temporary grace-period bridge and
  preserves the server-bound legacy role instead of accepting a new client role.

## Required Backend Env

Configure on the backend API service before enabling web v2 migration prompts.

| Env var                                                                     | Required                         | Recommended production value shape                                  | Recommended staging value shape                               | Notes                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AUTH_SESSION_HASH_SECRET`                                                  | Strongly recommended             | Dedicated high-entropy secret                                       | Dedicated high-entropy secret                                 | Falls back to `JWT_SECRET` if unset, but a separate secret isolates session hashing.                  |
| `AUTH_WEB_CREDENTIAL_ORIGINS`                                               | Required for cross-origin web v2 | `https://6529.io`                                                   | `https://staging.6529.io`                                     | Enables exact credentialed CORS only for v2 web-cookie auth routes. Do not put API origins here.      |
| `AUTH_WALLET_CHAIN_ID`                                                      | Optional                         | `1` or unset                                                        | `1` unless intentionally testing another supported auth chain | Defaults to Ethereum mainnet. Structured auth verification is pinned to this value.                   |
| `AUTH_CONNECTION_SHARING_DISABLED`                                          | Optional                         | unset or `false`                                                    | unset or `false`                                              | Missing env means connection sharing is enabled. Set `true` only as a kill switch.                    |
| `AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS`                                    | Optional                         | unset or positive integer such as `300`                             | unset or positive integer such as `300`                       | Controls one-time connection share lifetime.                                                          |
| `AUTH_STRUCTURED_SIGNATURES_REQUIRED`                                       | Rollout flag                     | `false` for silent/grace rollout, later `true`                      | `false` for initial validation, later `true`                  | Do not enable until FE/native/external client compatibility is verified.                              |
| `SESSION_V2_MIGRATION_DEADLINE`                                             | Rollout flag                     | unset initially, later ISO timestamp with timezone                  | unset initially, later ISO timestamp with timezone            | Exposed through `/api/settings.auth` so FE can prompt/enforce v2 migration without another FE deploy. |
| `AUTH_SIGNATURE_ALLOWED_DOMAINS` / `AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES` | Domain-dependent                 | Include any first-party web signing domains not covered by defaults | Include staging domains or suffixes                           | Controls structured-signature first-party web domain validation.                                      |
| `AUTH_SIGNATURE_AUDIENCE` / `AUTH_SIGNATURE_ALLOWED_AUDIENCES`              | Optional                         | API audience if overriding defaults                                 | API audience if overriding defaults                           | Keep narrow. Misconfiguration rejects valid signatures.                                               |
| `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED`                                        | Temporary compatibility          | unset or `true`                                                     | unset or `true`                                               | Disable only after websocket clients no longer rely on query-token auth.                              |

## Required Frontend Env

Configure in the frontend runtime/build env for the FE deployment.

| Env var                              | Required            | Production value      | Staging value                 | Notes                                                                                     |
| ------------------------------------ | ------------------- | --------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `API_ENDPOINT`                       | Required            | `https://api.6529.io` | `https://api.staging.6529.io` | Keep the direct public API endpoint.                                                      |
| `WEB_SESSION_CREDENTIAL_API_ORIGINS` | Required for web v2 | `https://api.6529.io` | `https://api.staging.6529.io` | Allows FE to send `credentials: "include"` to trusted cross-origin v2 web auth endpoints. |

## Deployment Order

1. Deploy backend branch first with strict migration flags off.
2. Run backend `dbMigrationsLoop` first so TypeORM/entity sync adds the nullable
   `refresh_tokens.role` column and any existing auth-session entities are
   synchronized.
3. Deploy backend `api`.
4. Verify backend health and auth settings:
   - `/api/settings` returns `auth.structured_signatures_required=false`.
   - `auth.session_v2_migration_deadline` is `null` while silent rollout is
     active.
5. Deploy frontend with `API_ENDPOINT` and
   `WEB_SESSION_CREDENTIAL_API_ORIGINS` set for the same environment.
   - Production web deploy target: `https://6529.io` Elastic Beanstalk app.
   - Staging web deploy target: `https://staging.6529.io` EC2/pm2 app.
6. Verify browser v2 flows from the real web origin:
   - session nonce
   - session login
   - session refresh
   - session logout
   - connection sharing create/redeem where applicable
7. Set `SESSION_V2_MIGRATION_DEADLINE` to a future ISO timestamp when the
   migration prompt should begin.
8. Monitor migration metrics and support channels during the grace period.
9. Set `AUTH_STRUCTURED_SIGNATURES_REQUIRED=true` only after web, native, and
   external clients are verified.
10. Remove or disable v1 refresh after the grace period and strict-mode rollout
    are complete.

## Silent Release Values

Use these for the backend-first production deploy:

- `AUTH_STRUCTURED_SIGNATURES_REQUIRED=false`
- `SESSION_V2_MIGRATION_DEADLINE` unset
- `AUTH_CONNECTION_SHARING_DISABLED` unset or `false`
- `AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED` unset or `true`

The frontend can then be deployed silently. New sign-ins use v2. Existing v1
sessions remain valid until the backend migration deadline or strict flag is
enabled.

## Migration Policy

Do not silently convert v1 refresh tokens into v2 sessions. Users should migrate
through one of these paths:

- sign the v2 structured auth message; or
- use connection sharing from an already-v2 authenticated session.

This keeps the v2 session model clean: every v2 session is created by a v2
signature or by a v2-authenticated connection-sharing flow.

## Rollback Notes

- If web v2 cookie refresh fails, unset `SESSION_V2_MIGRATION_DEADLINE` and keep
  `AUTH_STRUCTURED_SIGNATURES_REQUIRED=false`.
- If credentialed browser CORS is wrong, fix `AUTH_WEB_CREDENTIAL_ORIGINS` on
  backend and `WEB_SESSION_CREDENTIAL_API_ORIGINS` on frontend.
- If connection sharing causes issues, set
  `AUTH_CONNECTION_SHARING_DISABLED=true`; normal v2 login/refresh remains
  available.
- If v2 auth must be paused after FE deploy, v1 refresh remains available while
  strict mode is off.
