# Community App Identity Assertion -- "Sign in with 6529.io"

## Overview

The community app identity assertion flow lets third-party community apps
verify a user's 6529.io identity without handling wallet signatures
themselves. The user logs in to 6529.io (via the existing auth-v2
SIWE flow) and then approves a community app's request to receive their
wallet address.

This is **not** OAuth 2.0 -- it is a lightweight, purpose-built flow that
reuses auth-v2 session infrastructure and adds PKCE (RFC 7636) + state
protection.

## How It Extends Auth V2

Auth v2 provides SIWE-based wallet authentication with web and native
sessions (see `auth-session-v2.ts`). This flow builds on top of it:

1. **Session reuse**: The user must have an **active auth-v2 web session**
   to approve a community app. The approve endpoint calls
   `hasActiveWebSessionForAddressAndRole` to verify the session is live --
   not just a valid (but possibly logged-out) JWT.
2. **No new credentials**: No new tokens, refresh tokens, or sessions are
   issued. The community app receives only the wallet address.
3. **One-time codes in Redis**: A short-lived (5-minute) authorization
   code is stored in Redis, bound to the app, PKCE challenge, and state.

## What Does This Assert?

This flow asserts the **signing wallet address** of the user's active
auth-v2 web session. It does **not** assert a selected profile or handle.

After receiving the wallet address, the community app may optionally
fetch the public profile via:

```
GET /api/identities/by-wallet/:address
```

The profile lookup is a separate, unauthenticated read -- the identity
assertion itself is the wallet address only.

## Flow

```
Community App                    6529.io                      User
     |                              |                           |
     | 1. Generate code_verifier    |                           |
     |    + code_challenge          |                           |
     |    + state                   |                           |
     |                              |                           |
     | 2. Redirect user to          |                           |
     |    6529.io/auth/authorize    |                           |
     |    ?app=...&redirect_uri=... |                           |
     |    &state=...&code_challenge=...                         |
     |----------------------------->|                           |
     |                              | 3. Show consent page      |
     |                              |    "[App] wants to verify |
     |                              |     your 6529 identity"   |
     |                              |-------------------------->|
     |                              |                           |
     |                              | 4. User clicks Approve    |
     |                              |    (must be logged in     |
     |                              |     with active v2 session)|
     |                              |<--------------------------|
     |                              |                           |
     | 5. 6529.io stores code in    |                           |
     |    Redis: {address, app,     |                           |
     |    code_challenge, state}    |                           |
     |    Redirect to:              |                           |
     |    redirect_uri?code=...     |                           |
     |    &state=...                |                           |
     |<-----------------------------|                           |
     |                              |                           |
     | 6. POST /auth/authorize/exchange                         |
     |    {code, code_verifier,     |                           |
     |     state, app}              |                           |
     |----------------------------->|                           |
     |                              | 7. Verify:                |
     |                              |    - code exists (GETDEL) |
     |                              |    - challenge matches    |
     |                              |    - state matches        |
     |                              |    - app matches          |
     |                              |                           |
     |    {address, app}            |                           |
     |<-----------------------------|                           |
     |                              |                           |
     | 8. GET /api/identities/      |                           |
     |    by-wallet/:address        |                           |
     |    (optional, public)        |                           |
     |----------------------------->|                           |
     |    {profile...}              |                           |
     |<-----------------------------|                           |
```

## Security Properties

### PKCE (Proof Key for Code Exchange)

The community app generates a `code_verifier` (43–128 chars, base64url)
and computes `code_challenge = base64url(sha256(code_verifier))`. The
challenge is sent on the app-info/approve calls and stored with the code.
On exchange, the app sends the `code_verifier`, and the server verifies
it hashes to the stored challenge.

This prevents **code interception attacks**: an attacker who intercepts
the authorization code (e.g. from a browser redirect log) cannot exchange
it without the `code_verifier`, which never leaves the community app's
client-side code.

### State Parameter

The `state` parameter is generated by the community app, sent on the
authorize redirect, stored with the code, and verified on exchange. This
prevents **CSRF attacks**: the community app verifies the state it
receives in the redirect matches the one it sent.

### Atomic Code Consumption (GETDEL)

The exchange endpoint uses Redis `GETDEL` to atomically retrieve and
delete the code in a single operation. This ensures **one-time use even
under concurrent requests** -- if two exchange requests arrive
simultaneously for the same code, only one succeeds; the other finds the
key already deleted.

### Redis Availability Check

The approve endpoint verifies Redis is available before storing the code.
`redisSetJson` returns `void` even when Redis is down (it silently
no-ops), so the service:

1. Checks `getRedisClient()` is not null before proceeding.
2. Reads the code back after `redisSetJson` to confirm it was stored.

If either check fails, a **503 Service Unavailable** error is returned --
the user is not given a code that can never be exchanged.

### Active Session Requirement

The approve endpoint requires not just a valid JWT (via
`needsAuthenticatedUser()`) but also an **active auth-v2 web session**
(via `hasActiveWebSessionForAddressAndRole`). This prevents a user whose
session has been logged out -- but whose JWT hasn't expired yet -- from
approving community app access.

### Generic Error Messages

The exchange endpoint returns a generic "Invalid or expired authorization
code" on any verification failure (missing code, wrong PKCE, wrong state,
wrong app). This prevents **information leakage** about which specific
check failed, which could help an attacker probe for valid codes.

## Endpoints

### `GET /auth/authorize/app-info`

Returns metadata for a community app. Validates the app ID, redirect URI,
and PKCE code_challenge.

**Query parameters:**

- `app` (required, string, max 64) -- community app ID
- `redirect_uri` (required, URI) -- must be in the app's `allowedRedirectUris`
- `state` (optional, string, max 256) -- opaque state value
- `code_challenge` (required, string, exactly 43 chars) -- base64url(sha256(code_verifier))

**Response (200):**

```json
{
  "app_id": "ar-community-platform",
  "name": "6529 AR Platform",
  "description": "World-anchored AR layer gated by 6529.io identity",
  "is_dev": false
}
```

### `POST /auth/authorize/approve`

Approves a community app's identity assertion request. Requires
authentication (bearer JWT) **and** an active auth-v2 web session.

**Request body:**

- `app` (required, string, max 64) -- community app ID
- `redirect_uri` (required, URI) -- must be in the app's `allowedRedirectUris`
- `state` (optional, string, max 256) -- opaque state value
- `code_challenge` (required, string, exactly 43 chars) -- base64url(sha256(code_verifier))

**Response (200):**

```json
{
  "redirect_url": "https://example.com/callback?code=...&state=..."
}
```

**Errors:**

- `400` -- Unknown app, disallowed redirect URI, invalid code_challenge
- `401` -- Not authenticated, or no active auth-v2 web session
- `503` -- Redis unavailable (cannot store the authorization code)

### `POST /auth/authorize/exchange`

Exchanges an authorization code for the asserted wallet address. No
authentication required -- this is called by the community app's backend
using the code received via the redirect.

**Request body:**

- `code` (required, string, hex, 64 chars) -- the authorization code
- `code_verifier` (required, string, 43–128 chars, base64url) -- PKCE verifier
- `state` (required, string, max 256) -- must match the state from the authorize flow
- `app` (required, string, max 64) -- community app ID

**Response (200):**

```json
{
  "address": "0xabcd...",
  "app": "ar-community-platform"
}
```

**Errors:**

- `400` -- Invalid request body or invalid code_verifier format
- `401` -- Invalid or expired authorization code (generic; covers expired,
  already-consumed, wrong PKCE, wrong state, or wrong app)

## App Registry

Community apps are registered in a static map in
`community-app-auth.service.ts`. Each app has:

| Field                 | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `id`                  | Unique app identifier                                 |
| `name`                | Display name shown on the consent page                |
| `description`         | Human-readable description                            |
| `allowedRedirectUris` | Whitelist of permitted callback URLs                  |
| `isDev`               | `true` if the app entry is for local development only |

### `ar-community-platform`

- **Production redirect URI**: `https://6529-ar.arweave.dev/auth/callback`
- **Dev-only redirect URI**: `http://localhost:3000/6529-ar/auth/callback`
  (for local development; `isDev: false` on the app itself, but the
  localhost URI should not be enabled in production deployments)

> **Note on the production callback:** The original URI
> `https://arweave.net/6529-ar/auth/callback` returns 404 because
> `arweave.net` serves permaweb transaction data, not arbitrary SPA
> routes under `/6529-ar`. A dedicated gateway or subdomain
> (e.g. `6529-ar.arweave.dev`) is required for SPA client-side routing.

## Testing

Unit tests are in `community-app-auth.service.test.ts`. They cover:

- App registry lookup and redirect URI validation
- PKCE code_verifier / code_challenge validation and verification
- Authorization code creation (including Redis-unavailable and
  read-back-failure 503 cases)
- Authorization code exchange (happy path, atomic consumption, wrong
  PKCE, wrong state, wrong app, non-existent code, Redis unavailable)

Tests mock the Redis module to avoid requiring a live Redis instance.
