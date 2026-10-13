# Late-indexed transfer reconciliation

Transaction discovery runs independently for Memes, Meme Lab, Gradients and NextGen.
A global maximum transaction block is a progress marker, not proof that every
contract has finished inserting older transfers. Advancing ownership/activity
past that block could previously skip a late transfer permanently.

## Durable wallet refreshes

Every transfer upsert now writes `transfer_reconciliations` for both endpoints
and both `owners` and `activity` consumers in the same database transaction.
This includes the discovery SQL path, legacy TypeORM persistence and NextGen.
Rollback removes both the transfer and its pending refreshes. Duplicate upserts
refresh the request revision; requests coalesce per consumer and wallet.

Each consumer reads up to 250 oldest pending wallets from the primary database,
adds them to its normal block-based selection, and rebuilds their raw and
consolidated values. Ownership replays each selected wallet from the committed
transfer ledger, rather than adding deltas to possibly stale balances. Activity
reads full wallet histories from the primary capped at the selected target block.
Unknown Meme season metadata leaves work pending instead of publishing an
incomplete activity result. The historical block selection remains for rollout
compatibility and existing reset operations.

Only after raw and consolidated publication does a consumer acknowledge the
exact revision it read. A concurrent transfer upsert changes that revision, so
an old acknowledgement cannot delete the new request. Failure leaves requests
pending and ledger rebuilds are safe to retry without applying deltas twice.
The existing reserved concurrency of one per loop must remain in place.

After ownership publication, `nftOwnersLoop` records separate `balances`
requests. `ownersBalancesLoop` drains those after refreshing both raw and
consolidated balance tables, including deletion of sold-out wallets. This avoids
waiting for a new block or periodic balance refresh after repairing old transfers.

## Rollout order and repair of existing drift

1. Deploy and run `dbMigrationsLoop` with full entity sync to create the additive
   queue table. It does not enqueue a global historical repair.
2. Deploy `ownersBalancesLoop`, `aggregatedActivityLoop`, then `nftOwnersLoop`.
3. Deploy `transactionsLoop` (Memes, Meme Lab and Gradients functions) and
   `nextgenContractLoop`. Producers must not run this code before schema sync.
4. Audit stored ownership against the transfer ledger and chain for the affected
   collection. Queue both endpoints of confirmed stale transfers in batches
   of at most 100 using the maintenance request below. Wait for each wallet's
   `owners`, `activity` and `balances` requests to drain, and validate its raw
   and consolidated values. No global TDH recalculation is implied.

Deployment protects future writes; it does not retroactively create requests for
transfers that were already missed. An explicit bounded repair is required.
No repair or deployment is performed merely by opening this PR.

### Maintenance invocation

Invoke `nftOwnersLoop` directly using existing AWS IAM invocation access in the
intended environment/region:

```json
{"action":"repair-wallets","wallets":["<affected wallet address>","<other endpoint>"]}
```

This custom-only action validates 1–100 nonzero Ethereum addresses, deduplicates
and lowercases them, queues ownership and activity repair, and returns
`status: queued`. It does not run normal ownership processing, calculate TDH,
write transfers, upload anything, or call the chain. Scheduled loops subsequently
perform the actual repair. Unknown actions and invalid input fail closed.

For the confirmed Meme Lab token 71 discrepancy, the bounded repair candidates
are the two endpoints of each missed transfer:

- `0x04f722db8903ae85f5651b0a69524b53d48d5b9b`
- `0xb099a3c3043b262518d9b6cd4d5c9f589b15e2ad`
- `0x437c3056e488b3ad705039770a8c9d7446258de6`
- `0xa88fe6fa01fcc112bb2164c6e37d63395b923e5f`

Recheck the live ledger/chain before repair; this list is evidence from the
investigation, not an exhaustive audit of other collections or production.

## Operational limits

The queue persists until acknowledged; inspect pending counts/oldest requests
when diagnosing delays. The 250-wallet limit bounds queue draining, not existing
block catch-up/reset work or the length of an individual wallet's history.
Replaying active wallets (especially mint/burn endpoints) reads more history than
incremental balance deltas, so monitor duration/memory before broad rollout.
The repair is based on stored transfer history; missing or incorrect source
transfers must first be corrected by their indexer. Direct SQL edits to transfers
must also enqueue both endpoints in the same transaction.

For rollback, retain the additive queue table and pending requests. Reverting
consumers/producers removes protection until the fixed versions return; it does
not undo already corrected ownership/activity/balance values. This change does
not alter TDH scoring, rank tie-breaks, profile retention or consolidation policy.
