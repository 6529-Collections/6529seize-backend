---
name: database-skill
description: Implement database-related changes in this repository, including schema changes via TypeORM entities, repository/query patterns, request-context transactions, DB tests, and explicit data migrations. Use when working on DB schema updates, repositories or *Db classes, SQL queries, transactions, data backfills, or app logic that reads or writes MySQL data.
---

# Database Workflow

Apply this skill any time work involves database schema, queries, repositories, or migrations.

## Environment

1. Assume MySQL 8+ in all target environments.
2. Assume Aurora MySQL in staging/production.
3. Assume Docker MySQL locally.

## Schema Changes

1. Implement schema changes through TypeORM entities in `src/entities`.
2. Keep entity file naming pattern:
   - file name prefixed with `I`, example: `IMyThing.ts`
   - class name without `I` and suffixed with `Entity`, example: `MyThingEntity`
3. Export every new entity from `src/entities/entities.ts`.
4. Treat edits to existing entities as high risk and check for possible data loss before changing types or columns.
5. Never use foreign keys.
6. Prefer UUID primary keys unless sequential IDs are strictly required.
7. Prefer `bigint` Unix epoch milliseconds for time fields over SQL `datetime`/`date`.
8. For every new `@Entity(TABLE_NAME)`, add or use a table constant in `src/constants/db-tables.ts`.
9. Keep entity class/file names singular and table names plural.

## Queries And Repositories

1. Isolate DB access inside repository-style classes, usually `*Repository` or `*Db`.
2. Use caller-level transactions only when work must span multiple repositories:
   ```typescript
   await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
     const txCtx: RequestContext = { ...ctx, connection };
     await firstRepository.doWork(txCtx);
     await secondRepository.doMoreWork(txCtx);
   });
   ```
3. Make `ctx: RequestContext` the last argument of new repository functions unless the surrounding class has an established incompatible pattern.
4. Time new repository functions:
   ```typescript
   const timerName = `${this.constructor.name}->methodName`;
   try {
     ctx.timer?.start(timerName);
     // query work
   } finally {
     ctx.timer?.stop(timerName);
   }
   ```
5. Use `ctx.connection` when present so operations participate in caller-provided transactions:
   ```typescript
   const rows = await this.db.execute<MyEntity>(
     `select * from ${MY_TABLE} where id = :id`,
     { id },
     ctx.connection ? { wrappedConnection: ctx.connection } : undefined
   );
   ```
   For TypeORM transaction blocks, obtain repositories from the transaction manager passed by the transaction callback instead of the global data source.
6. Never use generated `Api*` classes in repositories.
7. Allow callers to use entity classes and repository-defined types.
8. Use constants from `src/constants/db-tables.ts` instead of hardcoded table names whenever possible.
9. Prefer typed queries via `execute<T>()` and `oneOrNull<T>()`.
10. Always pass an explicit comparator to `Array.prototype.sort`, including string sorts.

## Data Migrations

1. Use db-migrate only for explicit data migrations or view/one-off changes requested by the user.
2. Avoid db-migrate for schema changes unless the user explicitly asks for a migration; schema/table changes should normally come from TypeORM entities and `dbMigrationsLoop` sync.
3. Create migrations with:
   ```bash
   npm run migrate:new migration-name
   ```
4. Edit files created under `migrations/`.
5. Delete the generated `.down.sql` file and leave `exports.down` present as a no-op; do not implement revert logic.

## Tests

Place DB/repository tests next to the file under test and name them with lowercase hyphenated words ending in `.test.ts`. For DB integration patterns, follow `src/profiles/abusiveness-check.db.test.ts`.

## Validation

- [ ] Kept schema changes in entity classes unless the user explicitly requested a schema migration.
- [ ] Preserved entity naming convention and exported new entities.
- [ ] Checked entity edits for data-loss risk.
- [ ] Avoided foreign keys.
- [ ] Used UUID primary keys unless sequential ID was required.
- [ ] Used epoch-millis `bigint` for time where applicable.
- [ ] Added or used table name constants in `src/constants/db-tables.ts`.
- [ ] Kept DB logic in repository or `*Db` classes.
- [ ] Used transaction wrapper only when spanning repositories.
- [ ] Passed `ctx: RequestContext` through new repository APIs.
- [ ] Timed repository methods and used `ctx.connection` when available.
- [ ] Avoided generated `Api*` models in repositories.
- [ ] Used typed query methods and table constants in SQL.
- [ ] Used db-migrate only for explicit data/view migration work and left `exports.down` as a no-op.
- [ ] Added or updated focused tests for changed DB behavior.
- [ ] Ran `npm run lint`.
