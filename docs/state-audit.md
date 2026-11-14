# State audit: transfer ledger versus chain

`state-audit` is a read-only operator command. It fetches the canonical
ERC-721 / ERC-1155 transfer logs of one contract for one bounded block window
from the configured Ethereum RPC, compares them with the stored transfer ledger
(`transactions` table) for the same scope, and writes a versioned JSON manifest
describing every discrepancy and the downstream reconciliation work the apply
step needs. The audit never writes to the database, never enqueues
reconciliation, and never calls the chain for anything but reads.

`state-audit apply` is the gated second half: it consumes one reviewed
manifest, re-verifies it against the chain and the write database, repairs the
ledger one transaction at a time, and enqueues reconciliation for the affected
wallets in the same database transaction as each correction. See
[Applying a manifest](#applying-a-manifest).

## Running it

```sh
# Prints usage; touches neither the database nor the RPC.
6529 run state-audit -- --help

# Audit Meme Lab over 2,000 finalized blocks and write the manifest to a file.
6529 run state-audit -- --contract memelab \
  --from-block 21000000 --to-block 21001999 \
  --out memelab-21000000-21001999.json

# Same window, manifest on stdout, derived owner check restricted to two wallets.
6529 run state-audit -- --contract memes \
  --from-block 21000000 --to-block 21001999 \
  --wallets 0x04f722db8903ae85f5651b0a69524b53d48d5b9b,0xb099a3c3043b262518d9b6cd4d5c9f589b15e2ad
```

Options:

| Option                       | Meaning                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--contract`                 | `memes`, `gradients`, `memelab`, or one of their addresses. Any other address is accepted syntactically and reported as `unsupported_contract`.            |
| `--from-block`, `--to-block` | Inclusive window; at most 2,000 blocks. The window end must be at or below the finalized head.                                                             |
| `--chain-id`                 | Defaults to 1 and must equal the chain the RPC client is bound to (mainnet).                                                                               |
| `--wallets`                  | Optional comma-separated filter (at most 250) for the derived `nft_owners` check. Without it the check covers the wallets touched by ledger discrepancies. |
| `--out`                      | Write the manifest to this file; a one-line status then goes to stderr. Default: stdout.                                                                   |
| `--format`                   | `json` only.                                                                                                                                               |

The caller selects `NODE_ENV` and database access the same way as for other
operator commands. The command connects with `syncEntities: false` and
without Redis, and every statement it issues is a `SELECT` forced onto the
read pool. Startup diagnostics go to stderr so stdout holds one JSON document.

Exit codes: `0` clean, `3` differences found, `4` inconclusive, `2` usage
error, `1` execution failure (no manifest was produced).

## Reading the manifest

`manifest_version` is `1`. The important fields:

- `status`: `clean`, `differences_found` or `inconclusive`.
  `inconclusive_reasons` lists why a run is not conclusive; such a run must
  never be read as proof that the ledger is correct, even if `discrepancies`
  is empty.
- `requested_scope` / `inspected_scope`: what was asked for and what was
  actually read, including each `eth_getLogs` chunk and its log count, and
  whether coverage was `complete`.
- `anchors`: block numbers and hashes of the window ends and the finalized
  head at audit time. They are re-read after the logs and must be unchanged.
- `inspected`: the transaction hashes, block hashes and log indexes the audit
  decoded, so a reviewer can re-fetch the exact receipts.
- `digests.chain_edges`: SHA-256 of the canonical JSON of the normalized chain
  edge set. `digests.ledger_before_image`: the same for the ledger rows read
  for the scope. `ledger_before_image.row_count` is the number of rows.
- `discrepancies`: typed entries, each carrying the stored before-row and the
  expected row:
  - `missing_transaction`: the chain transaction has no ledger rows at all;
    `expected_rows` lists every row it should have.
  - `missing_edge`: the transaction is partly stored; one from/to/token edge
    is absent.
  - `token_count_mismatch`: the stored quantity differs from the summed chain
    quantity for the edge.
  - `token_id_mismatch`: the only unmatched stored row and the only unmatched
    chain edge of a transaction share endpoints but differ in token id.
  - `unexpected_row`: a stored row with no chain counterpart. `detail` says
    whether the whole transaction is absent on chain, only the edge is, or the
    row is a case-variant duplicate of another row's normalized key.
  - `owner_balance_mismatch`: the derived check (below) disagrees with
    `nft_owners`.
- `affected_wallets`: every wallet endpoint of a discrepancy, lowercased.
- `reconciliation_plan`: the wallets and consumers (`owners`, `activity`)
  that an apply step would enqueue through
  `transferReconciliationDb.enqueue(...)` in the same transaction as the ledger
  correction. The audit enqueues nothing.
- `plan_digest`: SHA-256 of the canonical JSON of the plan portion
  (version, chain, contract, inspected scope, anchors, status, input digests,
  discrepancies and reconciliation plan). The apply step recomputes it from
  the file and refuses to act if it differs from the file's own value or from
  the digest the operator reviewed.
- `data_sources` and `verification_assumptions`: the exact sources read and
  the assumptions the result rests on. Read them before relying on a result.

## The derived owner check

`derived_checks.owner_balance` is a derived comparison, not a direct chain
fact. For each checked wallet it replays the stored ledger outside the audited
window, replaces the in-window rows with the chain edges, applies the owners
consumer's rules (recipients credited, senders debited, the zero address never
debited), and compares the result with `nft_owners` at the contract's current
`MAX(block_reference)`. Its `assumptions` are embedded in every manifest.

The check is `skipped` when `nft_owners` has no rows for the contract or its
block reference is below the window end (the owners consumer has not
published the window yet), `truncated` when more than 250 wallets would need
replaying (the run becomes inconclusive; narrow the window or pass
`--wallets`), and `not_applicable` when there is nothing to check.

## Inconclusive results

The following always produce `inconclusive`, never `clean`:

- RPC errors, including retries exhausted (`rpc_error`).
- A chunk returning 10,000 or more logs, the common provider cap
  (`log_response_capped`), or logs outside the chunk or from another address
  (`foreign_log`).
- A transfer-topic log that does not decode (`unparsed_log`).
- A window end above the finalized head (`window_not_finalized`) or window
  hashes that changed while reading (`anchors_changed`).
- A chain quantity above the ledger's integer range (`amount_overflow`).
- Database read failures (`database_error`).
- NextGen, external collections or any address that is not Memes, Gradients
  or Meme Lab (`unsupported_contract`). NextGen ledger rows are written by
  `nextgenContractLoop` from a different event path and are out of scope.
- A requested chain id other than the RPC client's (`chain_id_mismatch`).

## What is not covered

- Value, royalty, gas, price and date columns are not compared.
- Per-log granularity: like the ingest path, edges are summed per transaction
  and from:to:contract:tokenId, so two logs moving the same edge in one
  transaction are one row.
- Intermediate block hashes are recorded from the logs, not re-fetched.
- TDH is not evaluated; a confirmed ledger correction still needs the
  documented TDH recalculation path (see below).

## Applying a manifest

```sh
# 1. Audit and keep the manifest.
6529 run state-audit -- --contract memelab \
  --from-block 26056000 --to-block 26057999 --out memelab-26056000.json

# 2. Review the manifest and note its plan_digest.
jq -r .plan_digest memelab-26056000.json

# 3. Dry run: validates, revalidates against chain and write pool, prints the
#    exact units. Writes nothing; the gate is not required.
6529 run state-audit -- apply --manifest memelab-26056000.json \
  --plan-digest <reviewed sha256> --job-id $(uuidgen | tr A-Z a-z)

# 4. Live, for this invocation only.
STATE_AUDIT_APPLY_ENABLED=true 6529 run state-audit -- apply \
  --manifest memelab-26056000.json --plan-digest <reviewed sha256> \
  --job-id <same uuid> --live
```

Options:

| Option            | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--manifest`      | The audit's JSON output file. Pass it unedited.                                                                          |
| `--plan-digest`   | The `plan_digest` the reviewer approved. Recomputed from the file; both the file's value and this argument must match.   |
| `--job-id`        | A UUID v4 chosen by the operator. It binds this manifest to one job row; reuse it to resume, never for another manifest. |
| `--live`          | Write. Requires `STATE_AUDIT_APPLY_ENABLED=true` in the environment. Without `--live` the command is a dry run.          |
| `--max-age-hours` | Reject manifests whose `generated_at` is older than this (default 168, seven days).                                      |

Exit codes: `0` planned, applied or already applied; `4` rejected with
nothing written; `1` a repair unit failed and the job is left for resumption
(or has been marked `failed`, see below); `2` usage error. One JSON report
goes to stdout; startup diagnostics go to stderr.

The command runs with `syncEntities: false`. The `state_audit_jobs` table is
created by the ordinary entity sync (`dbMigrationsLoop`); run that before the
first apply in an environment.

### What is checked before anything is written

Every check fails closed: a rejection writes nothing and creates no job.

1. The manifest must be `manifest_version: 1`, status `differences_found`
   with no inconclusive reasons and complete coverage, for Memes, Gradients
   or Meme Lab, on the RPC client's chain, and younger than `--max-age-hours`.
   `clean`, `inconclusive` and unsupported manifests are rejected.
2. `plan_digest` is recomputed from the file. An edited file, or a reviewed
   digest that does not match, is rejected (`plan_digest_mismatch`).
3. The job row, if present, must carry the same `plan_digest`
   (`job_digest_mismatch` otherwise). An `applied` job returns
   `already_applied` and nothing else happens. A `failed` job is rejected.
4. Block anchors are re-read: the window-end hashes must equal the manifest's
   and the manifest's finalized block must still be canonical; the finalized
   head may only have advanced (`stale_chain` otherwise).
5. The ledger rows of the scope are re-read on the **write** pool. For a new
   job their digest must equal `digests.ledger_before_image`; for a resumed
   job they must equal the before-image with the already-applied units
   replaced by their after-rows (`stale_database` otherwise).
6. The receipt of every transaction in the plan is re-fetched. Each must
   still sit in the audited block with the audited block hash; its contract
   transfer logs are decoded with the same code as the audit and diffed
   against the before-image. The result must equal the manifest's ledger
   discrepancies exactly (`plan_mismatch` otherwise).
7. Discrepancies the step cannot repair are rejected explicitly
   (`unsupported_discrepancy`): an `unexpected_row` whose detail is
   `duplicate_normalized_key`, because the manifest holds only the
   normalized key and a keyed delete would remove both case variants.

### Repair units

One unit is one transaction hash with all of its discrepancies:

| Discrepancy                           | Correction                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_transaction`, `missing_edge` | Insert the expected row with discovery's upsert statement and column set.                                                                               |
| `token_count_mismatch`                | `UPDATE token_count` on the stored row; its other columns are untouched.                                                                                |
| `token_id_mismatch`                   | `token_id` is part of the primary key: copy the stored row under the chain token id (keeping its value, gas and date columns), then delete the old row. |
| `unexpected_row`                      | Delete the stored row.                                                                                                                                  |
| `owner_balance_mismatch`              | Not written. The owners consumer rebuilds `nft_owners` from the corrected ledger once the wallet is enqueued.                                           |

Each unit runs in one `REPEATABLE READ` transaction, like discovery's upsert:

1. `SELECT ... FOR UPDATE` the transaction's current rows and compare them
   with the unit's before-rows; any difference aborts the unit as `stale`.
2. Lock the job row and require `next_index` to equal the unit's index.
3. Write the corrections.
4. `transferReconciliationDb.enqueue(wallets, ['owners','activity'], { connection })`
   for every endpoint of the before-rows and after-rows, the zero address
   excluded as in `repair-wallets`.
5. Advance `next_index` and `applied_units`; on the last unit set the job
   state to `applied`.

A failure anywhere rolls back all five steps for that unit.

Inserted rows get `transaction_date` from the block timestamp (the block is
fetched by the audited hash and must still match), `created_at` now,
`eth_price_usd` from the stored price history as discovery does, and the
discovery defaults (`0`) for `value`, `royalties`, `primary_proceeds`, the
gas columns, `value_usd` and `gas_usd`. Value enrichment
(`findDiscoveredTransactionValues`) is not run: it needs trace providers and
sale heuristics that are out of scope for a repair, and a wrong price is
worse than an explicit zero. The report states this under
`summary.value_enrichment`. Operators who need sale values on repaired rows
must backfill them separately.

### Partial progress, resume and recovery

- The job row (`state_audit_jobs`: `job_id`, `plan_digest`, `contract`,
  window, the approved manifest, the write-pool before-image, `state`,
  `next_index`, `applied_units`, `last_error`) is created only in live mode,
  after every check above passed, immediately before the first unit.
- A unit that fails for a transient reason (database error, enqueue failure,
  RPC error while fetching a block timestamp) leaves the job `pending` with
  `last_error`. Rerun the same command with the same `--job-id`; the run
  repeats every check, then continues from `next_index`. Units already
  committed are reported as `previously_applied` and are neither rewritten
  nor re-enqueued; the queue's `(consumer, wallet)` unique key means a wallet
  touched by several units still gets one pending request per consumer.
- A unit whose rows changed under it (`stale`) marks the job `failed`. The
  units before it stay applied. Run a fresh audit over the same window and
  apply the new manifest with a new job id.
- If another apply holds the cursor (`job_cursor_changed`) nothing is written
  and the job is left alone.
- The command never deletes or rewinds a job row. To abandon a `pending` job,
  leave it; its id simply must not be reused for a different manifest.

### What apply does not do

- No TDH recalculation. The report lists the affected wallets and the block
  window so the operator can scope the explicit `TDH_RESET` run documented
  for the TDH loop; apply never triggers it implicitly.
- No direct writes to `nft_owners`, `owners_balances`, aggregated activity or
  any TDH table. The `owners` and `activity` consumers rebuild those from the
  corrected ledger when they drain the enqueued wallets, and `nftOwnersLoop`
  then publishes `balances` requests as described in
  [transfer-reconciliation.md](transfer-reconciliation.md).
- No enqueue for the zero address, mirroring `repair-wallets`; its burn
  tallies in `nft_owners` are not refreshed by this step.
- No value enrichment on inserted rows (see above).
- No global reset of any loop.

## Tests

```sh
6529 run test -- src/nft-transfer-edges.test.ts src/state-audit
```

The audit database test seeds a ledger with a wrong historical ERC-1155
quantity and a wholly missing transfer, runs the auditor against a mocked
RPC, and wraps the SQL executor so that any non-`SELECT` statement or any
statement not forced onto the read pool fails the test.

The apply database test adds an unexpected row to that seed, produces a real
manifest with the auditor, and proves: a dry run issues only `SELECT`s; the
gate, a changed window hash, a moved receipt, a changed row, an edited
manifest (with and without a recomputed digest), an unsupported contract and
an unsupported discrepancy are all rejected with nothing written; an enqueue
failure rolls back the ledger correction of the same unit; a failure between
units leaves the job `pending` and a rerun resumes without repeating the
first unit or duplicating queue rows; an `applied` job is a no-op; rows
changed under a unit mark the job `failed`; and a fresh audit of the
corrected ledger reports no ledger discrepancies while the derived owner
check still shows the mismatches the queue consumers will clear.
