# Commiting to Git

**NEVER commit unless explicitly asked to by the user.** Do not assume the user wants you to commit. Wait for explicit instructions like "commit" or "commit this".

When you DO commit (only when explicitly asked), add a DCO signature to footer with my name and the corresponding accountcode+username@users.noreply.github.com email address. Example:

```
Add tests for address comparison
Signed-off-by: IAmAUser <1234567+IAmAUser@users.noreply.github.com>
```

# Writing unit tests

1. Put the tests next to file being tested.
2. Test file name should always end with `.test.ts`
3. Words in test file names should always be separated with dashes (except for the suffix `.test.ts`) and be all lowercase. For example if you test function doThis then the test file should be `do-this.test.ts`
4. Use fast-check where reasonable
5. When doing DB/Repository tests take example from file src/profiles/abusiveness-check.db.test.ts

# Linting

After you do your changes then run `npm run lint`. Make sure you fix all errors and warnings.

# Imports and path aliases

Use path aliases for **new** imports where applicable. Do not change existing imports to aliases just for consistency, to avoid unnecessary noise and large diffs.

- In **api-serverless** (see `src/api-serverless/tsconfig.paths.json`): Use `@/` for repo `src/` (e.g. `@/constants`, `@/numbers`, `@/sql-executor`). Use `@/api/*` for files under api-serverless `src/` (e.g. `@/api/memes-minting/allowlist-merkle`, `@/api/memes-minting/api.memes-minting.db`). New code in api-serverless must use these aliases, not relative paths for cross-folder imports.
- In **root** (e.g. loops, src outside api-serverless): root `tsconfig.json` has `@/*` → `src/*`; use `@/constants`, `@/entities`, etc. when adding new code.

# API types and OpenAPI (api-serverless)

All API request/response types must be defined via OpenAPI and the generated models. Do not hand-roll response types for API endpoints unless explicitly asked not to.

1. **Define in OpenAPI**: Add the endpoint and its request/response schemas in `src/api-serverless/openapi.yaml` (paths and `components/schemas`).
2. **Generate**: From `src/api-serverless` run `npm run restructure-openapi` then `npm run generate`. This creates/updates types under `src/api-serverless/src/generated/models/`.
3. **Use in routes**: Import from `@/api/generated/models/...` (or `../generated/models/...`) and use the generated classes for responses (and for POST/PUT bodies where applicable). Map your DB/service output to the generated model shape (e.g. snake_case properties) before returning.

# Database schema and migrations

Do **not** create new migrations for table creation or schema changes unless the user explicitly asks for them. Assume migrations are not needed.

- **New tables**: Add TypeORM entities and export them in `src/entities/entities.ts`. The dbMigrations loop runs with `sync=true`, which creates and updates tables from entities. Do not add migration files for new tables.
- **Schema changes**: Prefer updating the entity definition; sync will apply changes. Only add or edit migrations when the user explicitly requests a migration (e.g. for a one-off data migration or a view).
