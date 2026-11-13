# OpenSea market depth

The market collectors preserve OpenSea listings and offers for The Memes,
Meme Lab, Gradients and each indexed NextGen project. This supplies quoted
market depth and a rolling auditable history; see [Retention](#retention).

## Capture and storage

`marketStatsLoop` paginates the collection listing and offer endpoints alongside
the existing market statistics. A complete snapshot stores the original provider
payload and normalized orders as compressed archives. Current orders and the
completed snapshot pointer change in one database transaction. Failed or older
polls cannot replace a newer completed snapshot. NextGen projects are partitioned
by their OpenSea collection slug and local collection ID.

Existing price statistics and order-book collection run concurrently with
separate deadlines. Both tasks settle before the database context closes, so
a slow backfill cannot consume the time reserved for price statistics. All
NextGen order books are attempted before lifecycle maintenance begins.
The four collectors have 1 GiB of memory to accommodate concurrent work;
monitor reported peak memory as collection sizes grow.

`marketDepthStreamLoop` subscribes to listing, bid, collection offer, trait offer,
cancellation, invalidation, revalidation and sale events. It reconnects through
the official OpenSea SDK, batches writes and bounds its in-memory queue. REST
event catch-up uses a closed time window, overlap and a persisted pagination
cursor. Immutable event IDs deduplicate replay and overlapping sources.
Status reconciliation runs before REST catch-up. Catch-up processes a bounded
batch and checkpoints each completed page; a deferred batch resumes the same
closed window on the next run. Only the final page advances the completed
watermark. A planned pause is logged separately from provider or database
failure.

Orders missing from a newer snapshot enter persistent status reconciliation.
Expiry and confirmed provider status changes can produce observed lifecycle
events. A missing order or HTTP 404 is not proof of cancellation. Temporary
failures remain retryable. Public activity identifies whether an event came
from Ethereum, provider delivery or a status observation.

OpenSea Stream delivery is best effort. REST cannot replay every cancellation,
invalidation or revalidation. Recorded history is therefore not a guarantee of
every off-chain action, especially before capture began or during an outage.

## Interpretation

- Raw integer amounts and token IDs remain strings. Unit prices divide an
  order's original total by its original NFT quantity; remaining quantity is
  tracked separately after partial fills.
- Payment currencies remain separate. ETH and WETH are not added together.
- Private, inactive, expired and future-start orders do not contribute to
  current public depth. Recorded cancellations, invalidations and fills
  conservatively suppress older quotes until a complete refresh.
- Collection offers share one order budget across eligible tokens. Several
  offers can also share a bidder's funds, and several listings can share a
  seller's inventory. Displayed quantities are quoted depth, not a verified
  executable liquidity or acquisition-cost estimate.
- Explicit token criteria can establish eligibility. Unverified trait criteria
  remain visible separately and do not contribute to price levels.
- Dynamic-price orders, bundles and unsupported payment shapes remain in the
  source archive but do not receive a misleading fixed unit price.

## API

`GET /api/market-depth/{contract}/{token_id}` returns snapshot freshness,
currency-specific price levels, cumulative quoted quantities and paginated
orders. A cursor is bound to the book it started from. Reload the first page
when the book changes. `unavailable` means no completed capture; a completed
empty book is a different state. Snapshots older than one hour are marked stale.

`GET /api/nft-activity` merges canonical on-chain transactions with recorded
market lifecycle events. It accepts collection, token, wallet and action
filters and uses cursor pagination. Marketplace copies of sales and transfers
do not duplicate canonical transaction rows. Off-chain actions do not require
a transaction hash. Raw provider payloads are not returned by either API.

Activity reads use the read replica and may briefly lag newly captured events.
Critical order-book and order-status reads retain the writer. For token activity,
token-specific and collection-wide events are selected separately in descending
time/ID order, each limited to the requested page size plus one. Wallet, action
and cursor predicates apply inside both branches before their limits. At most
two pages of candidate IDs are merged before fetching the selected public
fields, using `idx_market_depth_events_token_occurred` without a schema change.
Request timer reports separate transaction, marketplace-event, history-start
and activity-partition query timings.

This activity optimization requires only an `api` deployment; the existing
schema, collectors and frontend remain compatible throughout the rollout.

## Snapshot publication coordination and timing

All four market-stats functions acquire the same transaction-scoped row in
`market_depth_publication_locks` immediately before deleting/reinserting current
orders. Provider fetching, normalization, compression and transactional archive
insertion stay parallel; current-order replacement through commit takes turns.
All publishers keep the partition → archive → shared lock → orders lock order. Commit or rollback releases the lock automatically. Lock acquisition
uses the database session's existing InnoDB lock-wait timeout; timeout errors
abort the whole publication and preserve the previous complete book.

`MARKET_DEPTH_DB` emits one `[SNAPSHOT PUBLICATION]` record per attempted
transaction, including failed attempts:

- `lock_wait_ms`: time acquiring the shared row, or time waiting before failure.
- `lock_held_ms`: time from acquisition through transaction finalization,
  including commit/rollback and adapter cleanup; null if never acquired.
- `insert_ms`: time mapping, constructing SQL and inserting all current-order
  batches; null if insertion was never attempted.
- `lock_wait_timeout_s`: the actual session InnoDB lock-wait limit, read without
  changing session settings.
- `total_ms`, `order_count`, `outcome`, `phase`, `lock_acquired`, public collection
  identifiers and generated snapshot ID support comparison across collectors.

Timings use a monotonic clock and milliseconds. `outcome=error` describes the
failed call and does not assert rollback after an ambiguous COMMIT. These logs
contain no provider payloads, order values or credentials. Compare wait and hold
percentiles against collection size and snapshot freshness before changing the
coordination strategy.

For this coordination change, deploy `dbMigrationsLoop` with
`db_schema_scope=market-depth-publication-lock` first, then `marketStatsLoop`
(all four functions). The scoped sync registers only the new lock entity and
skips unrelated migrations/maintenance. Old collectors remain compatible with
the additive table but do not coordinate until updated; allow in-flight old
invocations to settle before evaluating results. No API, stream or frontend
rollout is needed. Rolling back application code leaves the lock table intact.

## Deployment and verification

Use the repository deployment skill and current service catalog. Apply the
entity schema through `dbMigrationsLoop` before deploying `marketStatsLoop`,
`marketDepthStreamLoop` and the API. Deploy the dependent frontend afterward.
The database changes add tables; rollback should retain captured data and
restore the prior service artifacts rather than drop those tables.

Verify completed snapshots and progressing timestamps for all four contract
families, including each minted NextGen project. Compare an active multi-edition
order's original and remaining quantities with OpenSea. Exercise both APIs,
cursor replacement, empty and stale states, and market events without a
transaction hash. Inspect collector logs for exhausted retries, queue overflow,
failed catch-up or archive limits; a deployed Lambda version alone does not
prove successful capture.
Also verify that existing price statistics complete and that deferred REST
pages make progress across runs. A fresh order book alone does not prove that
historical catch-up has completed.

Check EventBridge rules targeting each collector after deployment. The
stack-managed schedules must be the only recurring trigger for these functions;
an older shared rule can otherwise queue duplicate work despite reserved
concurrency of one. When retiring a duplicate, first verify the replacement
rule is enabled and targets the same function, remove only that function's
target from the older rule, and read back both rules. Preserve all other
targets on shared rules.

## Retention

Each `marketStatsLoop` run ends with a retention pass for its own contract,
even when the refresh failed. Within a four-minute budget it deletes, in small
batches:

- snapshots completed more than 14 days ago, except the latest snapshot per
  collection and any snapshot still referenced by current orders;
- reconciliation rows whose `next_attempt_at` is more than 7 days old. These
  are resolved rows, or pending rows that waited unprocessed for the whole
  window; retried rows keep moving `next_attempt_at` forward;
- events observed more than 30 days ago, except every event for an order still
  in the live book. The depth API applies an order's latest terminal event
  regardless of age.

Each table is limited to 100,000 deleted rows per run, so a backlog drains over
several runs. The activity feed hides market events older than 30 days and
reports `market_history_started_at` no earlier than that cutoff. On-chain sales
and transfers come from `transactions` and are unaffected.

InnoDB reuses the freed pages for new rows, so table files stop growing but do
not shrink. Rebuild a table (`OPTIMIZE TABLE`) only when the space must return
to the volume, and only with free storage at least equal to its retained size.

Before this policy, roughly 1M events, 90K reconciliation rows and 300
snapshots a day accumulated without deletion. In October 2026 they filled the
staging database's storage.

Monitor snapshot count and compressed byte growth, reconciliation backlog and
oldest due retry, and last completed capture per partition. The collectors log
a retention summary per run. Combined compressed archives are
limited to 6 MiB per snapshot, with 4 MiB per archive. This keeps driver
hex-encoding below a conservative 16 MiB SQL packet budget, including headroom.
Oversize capture fails visibly instead of truncating depth.
