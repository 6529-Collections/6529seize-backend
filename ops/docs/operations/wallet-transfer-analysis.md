# Wallet transfer analysis

This operational analysis finds undeclared Memes wallet relationships from the
existing transaction history. Repeated reciprocal transfers and concentrated
one-way transfers are its first signals. It does not infer common control from
mint timing, call an LLM, fetch blockchain data, modify consolidations, publish
results, or change public profile behavior. Funding and sale-proceeds sequence
analysis are outside this first version.

## Storage and execution

The TypeORM entities in `src/entities/IWalletTransferAnalysis.ts` add:

| Table                             | Stored data                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet_transfer_pair_days`       | Directional pair/day transfer occasions, quantities, first/last times, and a sample transaction, partitioned by source block bucket. |
| `wallet_transfer_wallet_days`     | Wallet/day incoming and outgoing totals over the same eligible transfer population and block buckets.                                |
| `wallet_transfer_analysis_states` | Per-contract completed source block and summary update time.                                                                         |

The source collection is The Memes. Buckets are fixed at 1,000 blocks. Each
processed bucket replaces its previous pair and wallet summaries in one DB
transaction, together with any forward checkpoint change. A locked state row
serializes concurrent writers. Replaying a bucket does not add counts twice.
Source transactions are read from the primary DB, preventing replica lag from
advancing the checkpoint beyond rows visible to the worker.

`update` starts at the first stored Memes activity and resumes from saved
progress. Each invocation reconciles the latest processed bucket once, then
processes up to `--max-batches` new buckets. Empty ranges can be skipped using
the source contract/block index. Historical source corrections outside the
latest processed bucket require an explicit `rebuild` of the affected range.
Rebuild includes whole intersecting buckets and only accepts already processed
history; it cannot initialize progress or move the checkpoint past a gap.

## Transfer semantics

- A transfer occasion is grouped by transaction hash, from address, and to
  address. Multiple cards in that transaction count once for that direction.
- Quantities count ERC-1155 edition units. They do not identify individual
  copies or track the provenance of copies after inventory mixes.
- Addresses are normalized. Zero-address mints and burns, the configured burn
  and Manifold addresses, self transfers, and recorded paid transfers are
  excluded. Indexed zero value means no attributed payment in this dataset;
  it is not proof that there was no separate payment or private settlement.
- UTC day boundaries are used. A 30/90/365-day report includes the current
  partial UTC day and the preceding 29/89/364 days. Active days are counted distinctly over the
  selected window; overlapping day rows from different block buckets do not
  inflate day counts. V1 does not have a distinct-card metric, and does not sum
  daily unique-card counts to approximate it.
- Declared common ownership is excluded when reporting candidates. Transfers
  within declared groups remain in summary totals, so excluding a known pair
  does not artificially raise other relationships' concentration ratios.
- Candidate scores and rule explanations are deterministic screening rules,
  not calibrated ownership probabilities. Gifts, OTC transactions, services,
  and coordinated collecting can produce similar patterns.

Initial rules require at least three transfer occasions on three distinct UTC
days spanning at least seven days. Reciprocity additionally requires two
occasions on two distinct days in each direction. An outgoing concentration
flag means at least half of either wallet's eligible outgoing occasions in the
window went to the other wallet. The score combines persistence, reciprocity
and outgoing concentration; the report includes the rule version, thresholds,
both directions' counts, concentration ratios and an explanation for review.

## Commands

Use the existing repository environment setup to choose `NODE_ENV` and DB
access. The CLI never changes `NODE_ENV`, synchronizes schema, or starts Redis.
Do not put credentials in command arguments or reports.

```bash
./bin/6529 run wallet-transfer-analysis -- --help
./bin/6529 run wallet-transfer-analysis -- status
./bin/6529 run wallet-transfer-analysis -- explain --from-block 15000000 --to-block 15000999
./bin/6529 run wallet-transfer-analysis -- update --max-batches 1 --max-rows 10000
./bin/6529 run wallet-transfer-analysis -- report --days 90 --limit 100
./bin/6529 run wallet-transfer-analysis -- rebuild --from-block 15000000 --to-block 15000999
```

The block numbers above illustrate one aligned bucket; select actual ranges
from `status`. Invoking without a command, or with `--help`, prints usage without
opening a DB connection. `status` only reads source bounds and saved progress. `explain`
uses plain `EXPLAIN` for a bounded source query; it does not run that SELECT
with `EXPLAIN ANALYZE`.

| Control                                            | Default                 | Maximum                                   |
| -------------------------------------------------- | ----------------------- | ----------------------------------------- |
| Update new buckets per invocation, `--max-batches` | 5                       | 50, plus one latest-bucket reconciliation |
| Source rows per bucket, `--max-rows`               | 10,000                  | 100,000                                   |
| Rebuild intersecting buckets                       | Explicit range required | 50                                        |
| Explain intersecting buckets                       | Explicit range required | 1                                         |
| Report window, `--days`                            | 90                      | Supported values: 30, 90, 365, `all`      |
| Report output, `--limit`                           | 100                     | 1,000                                     |
| Report SQL execution budget                        | 5,000 ms                | Fixed                                     |
| Source SELECT execution budget                     | 2,000 ms                | Fixed                                     |
| Transaction row/metadata lock wait                 | 3 seconds               | Restored before returning the connection  |

The source reader requests one extra row to detect overflow. An over-budget
bucket fails without committing a partial summary or advancing past that
bucket. Earlier successfully committed buckets remain resumable. If a bucket
exceeds the maximum, investigate its contents and change the processing design
before attempting a larger backfill; do not skip the bucket.

The program writes one JSON result to stdout and diagnostics to stderr; the
package wrapper can also print its own command banner. Use
`./bin/6529 run --silent wallet-transfer-analysis -- report --days 90`
to suppress the package-manager banner when feeding a JSON parser.
Invalid arguments return exit code 2; execution failures return exit code 1.
There is no arbitrary SQL command, live schema option, or publication command.

## Performance rollout

1. Preview the schema diff using TypeORM SQL-memory mode with only the three
   wallet-transfer entities. Deploy `dbMigrationsLoop` with workflow input
   `db_schema_scope=wallet-transfer-analysis` to create these additive tables.
   The workflow invokes the matching scoped payload automatically. This scope
   skips unrelated entity synchronization, data migrations and maintenance.
   A normal unscoped invocation still has its existing full behavior; do not
   use it for this rollout when unrelated changes remain pending.
   Then install the matching code on the authorized runner host. No other
   Lambda or API deployment is required, and this change enables no schedule.
2. Run `status`. Record source bounds, completed summary coverage and the
   current rules version before measuring work. Source maximum means the last
   stored Memes transaction, not an independent guarantee of chain-tip or
   upstream ingestion freshness.
3. Run `explain` for a representative source bucket. Confirm use of the
   existing `(contract, block)` index and inspect estimated rows/sort work.
   Plan evidence does not substitute for a measured execution benchmark.
4. Run one `update --max-batches 1 --max-rows 10000` during an appropriate
   operating window. Measure wall time, rows processed, DB CPU, reads, lock
   waits and application latency. The invocation can process an additional
   latest-bucket reconciliation when summaries already exist.
5. Run a 30-day report, then larger windows as needed. Measure report latency
   and rows examined. `--limit` bounds output, not all rows scanned by SQL
   aggregation; an `all` report scans the lifetime summary population. The
   aggregate SELECT has a 5,000 ms server execution budget. If it times out,
   choose a narrower window and inspect DB load. Keep reports in the
   operational workflow, outside request-serving paths.
6. Increase batch count only if measurements leave sufficient DB headroom.
   Use the throttled historical runner below for sustained processing. Retain
   finite per-invocation and per-run caps; no inference-triggered automation
   is required. Continuous live updates require a separate explicit schedule.

Limits bound returned source rows, application memory, and per-bucket writes.
They are not DB CPU, transaction-duration, or total-backfill runtime guarantees.
A query may examine more rows than it returns. The worker reads existing
transactions but writes only its three derived tables. Index creation and the
initial history calculation still consume DB resources and must be measured.
The report's `report_query_budget_ms` records its aggregation statement budget;
it does not bound connection acquisition or the complete command's wall time.
The [MySQL SELECT execution-time hint](https://dev.mysql.com/doc/refman/8.0/en/optimizer-hints.html)
limits this statement's execution, not its instantaneous CPU or I/O demand.

Reports aggregate eligible undeclared pairs from summaries, preselect at most
10,000 by transfer count, then apply the versioned scorer and requested output
limit. If `preselection_truncated` is true, ranking is within that selected pool
and is not a global top-score ranking. Read the source/summary coverage and
window metadata alongside results; a partial historical backfill is not a
complete lifetime analysis. Sample transaction hashes are evidence pointers,
not an exhaustive transfer ledger.

`source_block_range_covered` compares the completed summary block range with
current source bounds. It does not detect new or changed rows inside an already
covered block. The state's `updated_at` records the latest derived-table write,
including an older-range rebuild; it is not a last-verification time for every
historical row. The report's `freshness_note` preserves this distinction.

## Throttled historical runner

`wallet-transfer-backfill` keeps one DB connection pool open while running
bounded updates. It does not invoke inference or launch a new process for each
bucket. Configure it after verifying the target writer endpoint, reading its
`@@server_uuid` and database name, and measuring its CloudWatch baseline:

```json
{
  "region": "us-east-1",
  "db_instance": "reviewed-writer",
  "database_uuid": "00000000-0000-0000-0000-000000000000",
  "database_name": "application",
  "state_directory": "/private/operator-state/memes-backfill",
  "limits": {
    "cpu": 35,
    "connections": 200,
    "read": 0.005,
    "write": 0.005,
    "memory": 2147483648
  },
  "duty_percent": 1,
  "max_invocations": 100,
  "max_run_minutes": 60,
  "max_rows": 10000
}
```

These values illustrate the format; choose actual thresholds from the target's
baseline and capacity. `cpu` is percent, `connections` is a count, `read` and
`write` are latency in seconds, and `memory` is minimum freeable bytes. Always
bind the instance identifier and region to the endpoint from which the UUID
was read. The runner rejects a different database UUID or schema before work
and on every iteration, including after restart.

```bash
./bin/6529 run --silent wallet-transfer-backfill -- /private/operator-config.json
```

The runner captures a fixed source target in `state.json`, processes one new
bucket plus the existing latest-bucket reconciliation, and rests outside
transactions. At one percent duty, each millisecond of measured update work is
followed by at least 99 milliseconds of rest; the minimum rest is two seconds.
Duty is capped at ten percent. This controls application pacing, not an exact
share of DB CPU. Start at one percent and only adjust after measured trials.
`max_rows` defaults to 10,000 and shares the CLI's 100,000-row ceiling. If a hot
bucket exceeds the configured limit, the runner stops; inspect that bucket's
plan and load before raising the limit and resuming. Never skip it.

Before each iteration, it checks the last three recent CloudWatch samples.
Metrics are refreshed at most once per minute. Excess load, incomplete samples,
stale data or monitoring failure pauses work. CPU/connections/read/write use
the largest of those samples; memory uses the smallest. Publication lag means
the gate cannot guarantee that brief instantaneous load spikes are detected.
Server-side source/report budgets and short transaction lock waits provide
additional limits.

A nonblocking MySQL advisory lock on a dedicated connection prevents another
supervisor for the same database and collection, even with a different state
directory or host. That connection holds no long-lived transaction. Ownership
is checked before work; losing the connection stops further processing. Use
one designated runner host and keep operator state private. `runner.lock`
also prevents simultaneous processes sharing a state directory.

Create a file named `pause` in the state directory to pause between invocations;
remove it to resume. A `stop` file or termination signal requests a graceful
stop after current work. Processing errors persist `failed` and require
inspection before explicitly changing that state to `paused`; no automatic
retry skips or repeatedly hammers a failing bucket. If a process was killed,
verify it has exited before removing a stale local `runner.lock`. MySQL
releases its advisory lock when the connection closes.

Runtime and invocation limits exit with `paused_budget`; invoke the same
configuration again to resume its fixed historical target. Once covered, the
runner reconciles the target's final bucket and records `complete`. It does
not chase new live blocks. Resume a completed history with a separately
reviewed incremental schedule; no schedule is installed by the code change.

## Recovery and rule changes

An interrupted bucket rolls back its summary replacement. Resume with
`update`; already committed buckets are retained and the latest is reconciled.
Use a bounded `rebuild` for corrections to older processed source history.
Run `status` and compare coverage before and after repair. Do not remove source
transactions, rewrite declared consolidations, truncate tables, or edit the
checkpoint to force progress.

Scoring changes are replayed by `report` over the existing summaries. Changes
to filtering, grouping or stored metrics require reviewing historical rebuild
coverage as well as changing the rule version. Repeatedly run bounded ranges
under the same performance controls; report the analysis as incomplete until
the necessary historical recalculation is finished.
