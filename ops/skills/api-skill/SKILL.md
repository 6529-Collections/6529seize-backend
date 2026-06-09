---
name: api-skill
description: Build or modify API endpoints in this repository by driving API contracts from src/api-serverless/openapi.yaml, regenerating generated models/routes, implementing thin handlers or legacy manual routes, and wiring validation/auth/timing correctly. Use when creating new API endpoints, changing API request or response models, adding generated x-6529-router operations, or updating API route behavior.
---

# API Development

Use this workflow for API contract, route, handler, and generated-model changes.

## Workflow

1. Update `src/api-serverless/openapi.yaml` first for every public request or response shape change.
2. Name new API schemas with an `Api` prefix and use generated models from `@/api/generated/models/...`.
3. Prefer generated route wiring for new endpoints. Add `x-6529-router` to the OpenAPI operation unless the generator cannot support the route shape or the user explicitly asks for manual routing:
   ```yaml
   x-6529-router:
     enabled: true
     auth: optional # optional | required | none
     cache: true # optional; emits cacheRequest()
     handler:
       import: "@/api/some-feature/get-something.handler"
       name: handleGetSomething
   ```
4. After editing OpenAPI, run both commands from `src/api-serverless`:
   ```bash
   npm run restructure-openapi && npm run generate
   ```
   `npm run generate:openapi` is equivalent when available.
5. Treat `src/api-serverless/src/generated` as generated-only; never edit it manually.
6. Implement handler/service logic after generated types exist, then verify the contract matches OpenAPI.

## Generated Routes

1. Add or update the OpenAPI operation with `operationId`, params, request/response schemas, and `x-6529-router`.
2. It is OK if the handler file does not exist yet. `npm run generate` writes the configured handler import/name into generated code; TypeScript fails until the handler is implemented.
3. Implement the handler at the exact `x-6529-router.handler.import` path and export the exact configured `name`.
4. Import generated operation request/query/path/body/response types from `@/api/generated/routes/operations` and generated models from `@/api/generated/models/...`.
5. Do not add duplicate manual `.routes.ts` wiring or app wiring for generated endpoints. The generated router is already mounted in `src/api-serverless/src/app.ts`.
6. If the generator rejects a needed route shape, extend `src/api-serverless/generate-openapi-routes.ts` when that is in scope; otherwise use a manual route and call out why.

Generated routes currently support path/query params, JSON request bodies that are `$ref`s, `200 application/json` object or array `$ref` responses, and `text/csv` string responses.

## Middleware Options

Use `x-6529-router.auth` for auth middleware and `x-6529-router.cache` for request caching:

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

## Handler Rules

1. For new generated endpoints, implement a thin handler file such as `src/api-serverless/src/<feature>/<operation>.handler.ts`.
2. Use generated operation types in the handler signature:
   ```typescript
   import { ApiSomething } from "@/api/generated/models/ApiSomething";
   import { GetSomethingRequest } from "@/api/generated/routes/operations";

   export async function handleGetSomething(
     req: GetSomethingRequest
   ): Promise<ApiSomething> {
     // validate input, call service, return generated response shape
   }
   ```
3. Validate route input with Joi using `getValidatedByJoiOrThrow` or `getValidatedByJoi`.
4. Keep handlers thin: validate input, prepare request context, call services, and return generated response shapes.
5. Never mark routes as cached unless explicitly instructed or an existing equivalent route is already cached for the same semantics.
6. Manual `.routes.ts` files are legacy/escape-hatch only.

## Auth And Context

1. Set `x-6529-router.auth: required` when authentication is required; generated routing uses `needsAuthenticatedUser()`.
2. Set `x-6529-router.auth: optional` when authentication is optional; generated routing uses `maybeAuthenticatedUser()`.
3. Use `getAuthenticationContext(req)` after auth middleware when auth context is needed.
4. Initialize `const timer = Timer.getFromRequest(req);` when downstream work should be timed.
5. Pass `timer` or a `RequestContext` to downstream service/repository calls when those APIs expect it.

## Validation

- [ ] Updated `src/api-serverless/openapi.yaml` first.
- [ ] All new schemas/models in OpenAPI start with `Api`.
- [ ] Added `x-6529-router.enabled: true` for new generated endpoints.
- [ ] Added `x-6529-router.cache` only when request caching is required.
- [ ] Declared the final handler import/name in `x-6529-router.handler`.
- [ ] Ran `cd src/api-serverless && npm run restructure-openapi && npm run generate`.
- [ ] Did not manually edit `src/api-serverless/src/generated/*`.
- [ ] Used generated operation types and generated models.
- [ ] Added Joi validation.
- [ ] Set auth correctly.
- [ ] Used `getAuthenticationContext(req)` where needed.
- [ ] Kept handler logic light and service-driven.
- [ ] Avoided duplicate manual route/app wiring for generated endpoints.
- [ ] Verified route behavior matches `openapi.yaml`.
