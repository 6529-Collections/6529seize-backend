# OpenSea market depth

The market collectors preserve OpenSea listings and offers for The Memes,
Meme Lab, Gradients and each indexed NextGen project. This supplies quoted
market depth and an auditable history for later economic analysis.

## Capture and storage

`marketStatsLoop` paginates the collection listing and offer endpoints alongside
the existing market statistics. A complete snapshot stores the original provider
payload and normalized orders as compressed archives. Current orders and the
completed snapshot pointer change in one database transaction. Failed or older
polls cannot replace a newer completed snapshot. NextGen projects are partitioned
by their OpenSea collection slug and local collection ID.

`marketDepthStreamLoop` subscribes to listing, bid, collection offer, trait offer,
cancellation, invalidation, revalidation and sale events. It reconnects through
the official OpenSea SDK, batches writes and bounds its in-memory queue. REST
event catch-up uses a closed time window, overlap and a persisted pagination
cursor. Immutable event IDs deduplicate replay and overlapping sources.

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

Archives are retained without an automatic deletion policy. Monitor snapshot
count and compressed byte growth, reconciliation backlog and oldest due retry,
and last completed capture per partition. Combined compressed archives are
limited to 24 MiB per snapshot to fit the database packet limit with driver
encoding overhead. Oversize capture fails visibly instead of truncating depth.
