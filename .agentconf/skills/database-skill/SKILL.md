---
name: database-skill
description: Implement database-related changes in this repository, including schema changes via entities, repository/query patterns, transactions, and data migrations. Use when working on migrations, DB schema updates, or app logic that touches the database.
---

# Database Workflow

Apply this skill any time work involves database schema, queries, repositories, or migrations.

## Environment Assumptions

1. Assume MySQL 8+ in all target environments.
2. Assume Aurora MySQL in staging/production.
3. Assume Docker MySQL locally.

## Schema Change Rules

1. Implement schema changes through TypeORM entities in `src/entities` (sometimes documented as `src/entitites`).
2. Keep entity file naming pattern:
   - File name prefixed with `I`, example: `IMyThing.ts`
   - Class name without `I` and suffixed with `Entity`, example: `MyThingEntity`
3. Treat edits to existing entities as high risk and check for possible data loss before changing types or columns.
4. Never use foreign keys.
5. Prefer UUID primary keys unless sequential IDs are strictly required.
6. Prefer `bigint` Unix epoch milliseconds for time fields over SQL `datetime`/`date`.
7. For every new `@Entity(TABLE_NAME)`, add/use a table constant in `src/constants/db-tables.ts` (example: `MY_THINGS_TABLE`).
8. Keep entity class/file names singular; keep table names plural (example table: `my_things`).

## Query and Repository Rules

1. Isolate DB access inside repository-style classes (usually `*Repository`, sometimes `*Db`).
2. Use caller-level transactions only when work must span multiple repositories:

```typescript
await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
  // do all the transactional stuff here by passing the connection with context
});
```

3. Make `ctx: RequestContext` the last argument of repository functions.
4. Time every repository function with this pattern:

```typescript
try {
  ctx.timer?.start(`${this.constructor.name}->nameOfTheCalledRepositoryFunction`);
  // do whatever you need to do here
} finally {
  ctx.timer?.stop(`${this.constructor.name}->nameOfTheCalledRepositoryFunction`);
}
```

5. Use `ctx.connection` when present, so operations participate in caller-provided transactions.
6. Never use generated `Api*` classes in repositories.
7. Allow callers (services/routes/etc.) to use entity classes and repository-defined types.
8. Use constants from `src/constants/db-tables.ts` instead of hardcoded table names whenever possible.
9. Prefer typed queries via `execute<T>()` and `oneOrNull<T>()`.

## Data Migration Rules

1. Use db-migrate only for data migration.
2. Never use db-migrate for schema changes.
3. Create migrations with:

```bash
npm run migrate:new migration-name
```

4. Edit files created under `migrations/`.
5. Delete the `down` migration path; do not implement revert logic.

## Practical Checklist

- [ ] Kept schema changes in entity classes (not SQL migrations).
- [ ] Preserved entity naming convention (`I*.ts` file, `*Entity` class).
- [ ] Checked entity edits for data-loss risk.
- [ ] Avoided foreign keys.
- [ ] Used UUID PK unless sequential ID was required.
- [ ] Used epoch-millis `bigint` for time where applicable.
- [ ] Added/used table name constants in `src/constants/db-tables.ts`.
- [ ] Kept table names plural and entity names singular.
- [ ] Kept DB logic in repository/`*Db` classes.
- [ ] Used transaction wrapper only when spanning repositories.
- [ ] Passed `ctx: RequestContext` as last parameter.
- [ ] Added timer start/stop in repository methods.
- [ ] Used `ctx.connection` when available.
- [ ] Avoided generated `Api*` models in repositories.
- [ ] Used typed query methods and table constants in SQL.
- [ ] Used db-migrate only for data migration and removed down path.
