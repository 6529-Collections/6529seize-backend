---
name: api-skill
description: Build or modify API endpoints in this repository by driving changes from openapi.yaml, regenerating API models, implementing routes manually, and wiring validation/auth/timing correctly. Use when creating new APIs, changing existing APIs, or updating API request/response models.
---

# API Development Workflow

Follow this workflow for any API change in this repository.

## Core Rules

1. Define API contract first in `src/api-serverless/openapi.yaml`.
2. Start every new schema/model name with `Api`.
3. After editing `openapi.yaml`, run:
   ```bash
   cd src/api-serverless && npm run generate
   ```
4. Treat `src/api-serverless/src/generated` as generated-only.
   - Never edit files in this folder manually.
5. Remember generation scope:
   - Generates request/response body models.
   - Does not generate routes.
   - Does not generate query/path param types.

## Route Implementation Rules

1. Implement routes manually in files ending with `.routes.ts`.
2. Ensure routes align 100% with `openapi.yaml` (paths, params, payloads, responses).
3. If query/path param typing is needed, define those types manually in the route file (or nearby file as appropriate).
4. Wire every new route file into `src/api-serverless/src/app.ts`.
5. Validate route input with Joi using `getValidatedByJoiOrThrow` (`getValidatedByJoi`) and a schema (typically defined in the route file).
6. Never mark routes as cached unless explicitly instructed.

## Auth and Request Context Rules

1. Use `needsAuthenticatedUser()` when authentication is required.
2. Use `maybeAuthenticatedUser()` when authentication is optional.
3. Use `getAuthenticationContext(req)` after auth middleware when auth context is needed.
4. In routes, always initialize timer:
   ```typescript
   const timer = Timer.getFromRequest(req);
   ```
5. Pass `timer` to downstream service calls and use it to time work as needed.

## Route Layer Responsibilities

Keep routes thin:

1. Validate input with Joi.
2. Do only very light request preparation.
3. Call an appropriate service class for business logic.
4. Await the service result and return it.

Do not place heavy business logic in routes.

## Practical Checklist

- [ ] Updated `src/api-serverless/openapi.yaml` first.
- [ ] All new schemas/models in OpenAPI start with `Api`.
- [ ] Ran `cd src/api-serverless && npm run generate`.
- [ ] Did not manually edit `src/api-serverless/src/generated/*`.
- [ ] Implemented/updated `.routes.ts` file(s) manually.
- [ ] Added manual query/path param types where needed.
- [ ] Added Joi schema validation via `getValidatedByJoiOrThrow`.
- [ ] Applied auth middleware (`needsAuthenticatedUser`/`maybeAuthenticatedUser`) correctly.
- [ ] Used `getAuthenticationContext(req)` where needed.
- [ ] Wired `const timer = Timer.getFromRequest(req);` and passed timer onward.
- [ ] Kept route handler logic light and service-driven.
- [ ] Wired route file in `src/api-serverless/src/app.ts`.
- [ ] Verified route contract matches `openapi.yaml` exactly.
