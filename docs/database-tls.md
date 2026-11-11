# Database TLS

MySQL connections from the TypeORM data source (`src/db.ts`) and the API read
and write pools (`src/db-api.ts`) support opt-in TLS. It is off by default, so
existing environments keep their current behaviour until it is enabled.

| Variable         | Effect                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DB_SSL`         | `true` enables TLS with server certificate verification (`rejectUnauthorized: true`). Any other value, or unset, keeps TLS off.            |
| `DB_SSL_CA_FILE` | Optional path to a PEM bundle used as the trusted CA list when `DB_SSL=true`. Unset uses Node's default trust store. Read at connect time. |

Which trust source fits depends on the endpoint:

- RDS Proxy endpoints present ACM-issued certificates that chain to Amazon
  Trust Services roots, which are in Node's default trust store. Leave
  `DB_SSL_CA_FILE` unset.
- Direct RDS instance or cluster endpoints present certificates signed by the
  RDS certificate authorities, which are not in Node's default store. Ship the
  [RDS global bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
  with the function and set `DB_SSL_CA_FILE` to its path.

The legacy `Amazon RDS` SSL profile built into the `mysql` driver is not used:
its bundled certificates predate the current RDS certificate authorities.

Redis TLS is configured separately with `REDIS_TLS=true` (`src/redis.ts`).

## Enabling per environment

Lambdas read these variables from the regional `prod/lambdas` secret (or the
function environment); local development reads `.env.<NODE_ENV>`.

1. Confirm on AWS which endpoint each environment uses (`DB_HOST`,
   `DB_HOST_READ`) and, for RDS Proxy, that the proxy allows TLS (Require
   Transport Layer Security or optional TLS) and that its targets accept the
   proxy's connections.
2. Add `DB_SSL=true` (and `DB_SSL_CA_FILE` if needed) to the staging secret,
   deploy or restart one consumer of each kind (`api`, a TypeORM loop such as
   `dbMigrationsLoop` with `db_schema_scope=maintenance`), and check that
   connections succeed. For a direct endpoint, `SHOW STATUS LIKE 'Ssl_cipher'`
   is non-empty for the session. Through RDS Proxy that status describes the
   proxy's own database connection, so confirm client TLS by setting the
   staging proxy to require TLS once every client has `DB_SSL=true`.
3. Repeat for production. Lambdas pick up secret changes on their next cold
   start.

To roll back, remove `DB_SSL` or set it to `false`.

Operator scripts under `ops/scripts/` create their own TypeORM data sources and
do not read these variables.
