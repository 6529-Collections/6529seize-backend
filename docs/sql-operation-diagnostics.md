# API SQL operation timing

The API's MySQL executor extends the existing `MYSQL_HELPERS` slow SQL warning
with structured `sql_operation` details. A completed operation warns when its
total duration exceeds one second, including connection acquisition. Failures
also include a terminal timing diagnostic. Existing SQL error handling and query
redaction are retained.

An operation still pending at one second emits one snapshot, with the same
`operation_id` as its eventual terminal diagnostic. The one-shot timer is
unreferenced and cleared on completion or failure. It does not cancel database
work, repeat warnings, or keep a Lambda alive. A runtime freeze or blocked event
loop can delay the snapshot; its absence does not prove that a wait was short.

| Field            | Meaning                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `outcome`        | `pending`, `completed`, or `failed`                                                                                |
| `stage`          | `acquisition`, `sql_setup`, `sql`, or `result` at the diagnostic                                                   |
| `pool`           | Selected `READ`/`WRITE` pool, or `supplied` for a caller-owned connection                                          |
| `acquisition_ms` | Time awaiting the pool callback, or elapsed acquisition time while pending/failed; `null` for supplied connections |
| `sql_ms`         | Time from calling `connection.query` to its callback, or elapsed SQL time while pending; `null` before SQL starts  |
| `total_ms`       | Time since this executor operation started, including acquisition and result handling                              |

Measurements use a monotonic clock and are rounded to milliseconds. The existing
`SQL query took ... ms to execute:` prefix still reports SQL execution time;
use `total_ms` to understand why a fast query produced a warning. Pending and
terminal diagnostics retain the originating logger request context even if a
driver callback runs in another context. Private table families hide statements
and parameters in both diagnostics, using the existing redaction policy.

Acquisition time includes any pool queueing, connection establishment, and
validation performed by the MySQL driver; it does not distinguish those causes.
Supplied transaction connections report only this statement's work, never a
fabricated share of the transaction's earlier connection wait. Transaction
creation itself and the separate TypeORM executor used by backend loops are
outside this diagnostic. Elapsed measurements can include Lambda suspension and
are not server-side execution measurements.

This change requires the `api` deployment only. It changes no API contract,
schema, pool configuration, timeout policy, or service dependency.
