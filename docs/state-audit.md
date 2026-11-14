# State audit: transfer ledger versus chain

`state-audit` is a read-only operator command. It fetches the canonical
ERC-721 / ERC-1155 transfer logs of one contract for one bounded block window
from the configured Ethereum RPC, compares them with the stored transfer ledger
(`transactions` table) for the same scope, and writes a versioned JSON manifest
describing every discrepancy and the downstream reconciliation work a separate
apply step would need. It never writes to the database, never enqueues
reconciliation, and never calls the chain for anything but reads.

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
  discrepancies and reconciliation plan). A future apply step re-derives the
  plan and refuses to act if the digest differs.
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
  documented TDH recalculation path.
- Applying corrections. This command is the read-only half; the apply step
  with its gate, approval digest and idempotent job record is a separate
  change and must re-run this audit and match `plan_digest` first.

## Tests

```sh
6529 run test -- src/nft-transfer-edges.test.ts src/state-audit
```

The database test seeds a ledger with a wrong historical ERC-1155 quantity
and a wholly missing transfer, runs the auditor against a mocked RPC, and
wraps the SQL executor so that any non-`SELECT` statement or any statement not
forced onto the read pool fails the test.
