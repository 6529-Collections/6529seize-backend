# Schema sync plan check

`dbMigrationsLoop` synchronizes the database schema with the TypeORM entities
(`src/db/bounded-schema-sync.ts`). It applies the statements TypeORM's schema
builder plans, the same ones `synchronize()` would run. Some of those
statements remove data: when a property is removed from an entity TypeORM
drops the column, and when a column's type or length changes it drops the
column and adds it again empty. Before anything is applied, the plan is now
classified (`src/db/schema-sync-plan-check.ts`) so such a plan is visible, and
it can be held back until someone has looked at it.

## Classification

Each planned statement is put in one of four groups.

| Group         | Statements                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `additive`    | `CREATE TABLE`, `CREATE VIEW`, `CREATE [UNIQUE] INDEX`, and `ALTER TABLE` clauses `ADD <column>`, `ADD [UNIQUE] INDEX`, `ADD PRIMARY KEY`, `ADD CONSTRAINT ... FOREIGN KEY`, `COMMENT`.                                                                                                                          |
| `in_place`    | `ALTER TABLE ... CHANGE` (a column changed in place or renamed; TypeORM's routine default, nullability and collation changes take this form), index and foreign key renames (`DROP INDEX a, ADD INDEX b`), `DROP VIEW`, `DROP FOREIGN KEY`, and the drops listed below when the catalog shows they lose nothing. |
| `bookkeeping` | `INSERT`, `UPDATE` and `DELETE` on `typeorm_metadata`.                                                                                                                                                                                                                                                           |
| `destructive` | `DROP COLUMN` of a stored (non-generated) column, `DROP INDEX` of a unique index, `DROP PRIMARY KEY`, `DROP TABLE`, `RENAME TABLE`, and any statement or clause the parser does not recognise.                                                                                                                   |

Drops are checked against `information_schema` on the sync's own connection:

- Dropping a generated column is `in_place`: its values are derived from
  other columns and TypeORM adds it back.
- Dropping a non-unique index is `in_place`. TypeORM drops and recreates the
  indexes on any column it changes.
- Dropping a unique index or the primary key is `in_place` only when the same
  plan creates a unique index (or primary key) on the same table with exactly
  the same columns; otherwise it is `destructive`.
- A column or index that cannot be found in the catalog is `destructive`.

A `CHANGE` that narrows a column in place (for example a smaller `DECIMAL`
precision, or fewer `ENUM` values) is not detected; it is reported as
`in_place`.

## Report and block modes

The SHA-256 of the destructive statements, in plan order, with their
parameters (`destructivePlanSha256`) identifies a destructive plan. Only the
destructive statements are hashed: the hash changes when any of them changes
(its SQL text, its parameters, their order, or one is added or removed), and
not when only the additive or in-place statements of the plan change. It
differs between environments when their destructive statements differ.

`SCHEMA_SYNC_DESTRUCTIVE_GUARD` selects the mode (in the Lambda's environment
or its secret):

- unset, empty or `report` (the default): a plan with destructive
  statements is logged as `[SCHEMA_SYNC_DESTRUCTIVE_PLAN]` (every statement
  with its group and reason, plus `destructivePlanSha256`), counted in the
  `6529/SchemaSync` `SchemaSyncDestructivePlan` metric with `Outcome=reported`,
  and then applied as before.
- `block`: such a plan is logged and counted the same way
  (`Outcome=refused`), none of it is applied, and the invocation fails with
  `SchemaSyncDestructivePlanRefusedError`, whose message names the SHA-256.
- any other value: the invocation fails before schema synchronisation starts,
  with an error naming the accepted values. Values are trimmed and compared
  case-insensitively.

Report mode is the default because the classification has not yet been
checked against the production schema: the first deployments with this check
show, in the `[SCHEMA_SYNC_DESTRUCTIVE_PLAN]` log and metric, whether ordinary
deploys ever plan a statement classified as destructive. Switch to `block`
once they do not.

## Applying a reviewed destructive plan

In `block` mode, after reviewing the logged plan:

1. Copy `destructivePlanSha256` from the `[SCHEMA_SYNC_DESTRUCTIVE_PLAN]` log
   line or the error message.
2. Invoke `dbMigrationsLoop` directly with the same scope and the hash:

   ```json
   {
     "schema_scope": "full",
     "approved_destructive_plan_sha256": "<64 lowercase hex characters>"
   }
   ```

The plan is applied only if its destructive statements still hash to that
value; if a schema or entity change in between altered those statements, it
is refused again with the new hash. A change that only alters the plan's
other statements keeps the hash, and the acknowledged run applies the whole
current plan. The field is accepted on explicit invocations of any scope that
synchronizes entities, must be a lowercase SHA-256 hex digest, and is rejected
on scheduled invocations. The `Deploy a service` workflow does not send it, so
a refused plan is applied only through a direct invocation.
