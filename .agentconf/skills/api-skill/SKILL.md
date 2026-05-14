---
name: api-skill
description: Build or modify API endpoints in this repository by driving changes from openapi.yaml, regenerating API models and generated route wiring, implementing thin handlers, and wiring validation/auth/timing correctly. Use when creating new APIs, changing existing APIs, or updating API request/response models.
---

# API Development Workflow

Follow this workflow for any API change in this repository.

## Core Rules

1. Define API contract first in `src/api-serverless/openapi.yaml`.
2. Start every new schema/model name with `Api`.
3. New endpoints must use generated route wiring by default. Add `x-6529-router` to the OpenAPI operation:
   ```yaml
   x-6529-router:
     enabled: true
     auth: optional # optional | required | none
     cache: true # optional; emits cacheRequest()
     handler:
       import: "@/api/some-feature/get-something.handler"
       name: handleGetSomething
   ```
4. After editing `openapi.yaml`, run:
   ```bash
   cd src/api-serverless && npm run generate
   ```
5. Treat `src/api-serverless/src/generated` as generated-only.
   - Never edit files in this folder manually.
6. Remember generation scope:
   - Generates request/response body models under `src/generated/models`.
   - Generates route wiring and operation request/query/path/response types under `src/generated/routes`.
   - Current generated route support is for path/query params with a `200 application/json` `$ref` response. If a new endpoint needs unsupported features such as request bodies, extend the generator first unless the user explicitly asks for manual routing.
   - Generated routes can include `cacheRequest()` via `x-6529-router.cache`.

## Generated Route Workflow

1. Add or update the OpenAPI operation, including `operationId`, params, response schema, and `x-6529-router`.
2. It is OK if the handler file does not exist yet. `npm run generate` only writes the configured handler import/name into generated code; TypeScript will fail until the handler is implemented.
3. Run `cd src/api-serverless && npm run generate`.
4. Implement the handler at the exact `x-6529-router.handler.import` path and export the exact configured `name`.
5. Import generated request/response types from `@/api/generated/routes/operations` and generated models from `@/api/generated/models/...`.
6. Do not add duplicate manual `.routes.ts` wiring or app wiring for generated endpoints. The generated router is already mounted in `src/api-serverless/src/app.ts`.

## Generated Middleware Options

Use `x-6529-router.auth` for auth middleware and `x-6529-router.cache` for request caching.

```yaml
x-6529-router:
  enabled: true
  auth: required
  cache:
    ttlSeconds: 900
    authDependent: true
  handler:
    import: "@/api/some-feature/get-something.handler"
    name: handleGetSomething
```

- `cache: true` emits `cacheRequest()`.
- `cache.ttlSeconds` emits `cacheRequest({ ttl: Time.seconds(value) })`.
- `cache.authDependent: true` includes the authenticated/anonymous identity in the cache key.
- `cache.methods` can be used for non-GET generated routes when needed.

## Route Implementation Rules

1. For new generated endpoints, implement a thin handler file such as `src/api-serverless/src/<feature>/<operation>.handler.ts`.
2. Handler signature should use generated operation types:
   ```typescript
   import { GetSomethingRequest } from '@/api/generated/routes/operations';
   import { ApiSomething } from '@/api/generated/models/ApiSomething';

   export async function handleGetSomething(
     req: GetSomethingRequest
   ): Promise<ApiSomething> {
     // validate input, call service, return generated response shape
   }
   ```
3. Ensure handler behavior aligns 100% with `openapi.yaml` paths, params, payloads, responses, and auth.
4. Validate route input with Joi using `getValidatedByJoiOrThrow` (`getValidatedByJoi`) and a schema, typically defined in the handler file.
5. Never mark routes as cached unless explicitly instructed.
6. Manual `.routes.ts` files are legacy/escape-hatch only. Do not create a manual route for a new endpoint unless the user explicitly asks or the generator cannot support the endpoint and extending it is out of scope.

## Auth and Request Context Rules

1. Set `x-6529-router.auth: required` when authentication is required; generated routing uses `needsAuthenticatedUser()`.
2. Set `x-6529-router.auth: optional` when authentication is optional; generated routing uses `maybeAuthenticatedUser()`.
3. Use `getAuthenticationContext(req)` after auth middleware when auth context is needed.
4. In handlers, always initialize timer:
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
- [ ] Added `x-6529-router.enabled: true` for every new endpoint.
- [ ] Added `x-6529-router.cache` when request caching is required.
- [ ] Declared the final handler import/name in `x-6529-router.handler`.
- [ ] Ran `cd src/api-serverless && npm run generate`.
- [ ] Did not manually edit `src/api-serverless/src/generated/*`.
- [ ] Implemented the handler file exported in OpenAPI after generated types exist.
- [ ] Used generated operation request/query/path/response types from `@/api/generated/routes/operations`.
- [ ] Added Joi schema validation via `getValidatedByJoiOrThrow`.
- [ ] Set `x-6529-router.auth` correctly for the endpoint.
- [ ] Used `getAuthenticationContext(req)` where needed.
- [ ] Wired `const timer = Timer.getFromRequest(req);` and passed timer onward.
- [ ] Kept handler logic light and service-driven.
- [ ] Did not add duplicate manual route/app wiring for generated endpoints.
- [ ] Verified route contract matches `openapi.yaml` exactly.
