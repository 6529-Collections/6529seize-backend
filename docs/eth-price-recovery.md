# ETH/USD collection and recovery

`ethPriceLoop` uses the public Coinbase Exchange ETH-USD ticker and five-minute
candles. It needs no Coinbase key. Mobula is no longer used by this loop;
`ETHERSCAN_API_KEY` retains its unrelated NextGen contract lookup use.

The existing five-minute EventBridge schedule, concurrency of one, and
`eth_price(timestamp_ms, date, usd_price)` schema are unchanged. No entities,
tables, columns, indexes, migrations, API contracts, or frontend changes are
required.

## Normal invocation

1. Read price coverage on the primary database, including interior holes and the
   trailing interval up to the invocation's start time. The historical lower
   bound remains October 1, 2021 UTC. A gap must exceed six minutes thirty seconds,
   allowing ordinary scheduling jitter. This also fills sparse older history and
   bootstraps an empty table; the newest live row cannot hide an earlier hole.
2. Process the eight most recent gaps first, requesting at most one 24-hour chunk
   per gap per invocation. Backfill starts at the recent end of a long gap.
   Continue independent gaps if a provider range fails. Missing Coinbase closes
   receive a 24-hour retry cooldown in existing Redis. Gap discovery temporarily
   excludes those exact intervals before selecting its eight candidates, so more
   than eight unavailable ranges cannot hide older work. No price rows are
   fabricated, and the holes become eligible again when the cooldown expires.
3. Resume a requested reset using any remaining chunk budget.
4. Fetch and save the latest trade from `/products/ETH-USD/ticker`, including its
   provider timestamp. Reject nonpositive/nonfinite prices, trades over five
   minutes old, or timestamps more than thirty seconds in the future.

When there are no gaps and no unfinished reset, the only provider request is
for the live ticker (normally 288 requests/day). A 32-hour outage normally
requires two invocations for its historical coverage, while live collection
resumes on the first successful invocation. Older gaps can require further runs.

History uses `/products/ETH-USD/candles?granularity=300` with explicit UTC start
and end boundaries. Each chunk expects at most 288 candles, below the provider's
300-candle limit. A candle's close is stored at the **end** of its five-minute
interval, so a transaction is never valued using a future close. The newest
eligible close is at least one minute old. Overfetched buckets are filtered;
duplicate, invalid, or misaligned candles fail that chunk. Partial and empty
responses are valid because Coinbase may publish no ticks for an interval. Save
only returned candles and log/defer missing closes for a daily retry. No zero,
interpolated, or invented prices are inserted to hide unavailable history.

Normal recovery inserts missing timestamp keys and preserves existing samples.
Coinbase reflects a single exchange and can differ from Mobula's aggregate.
Five-minute candles reconstruct historical coverage, not the exact live quotes
that were missed. Transactions continue to use the latest saved sample at or
before their timestamp.

## Atomic correction of app values

Each chunk commits its price inserts, affected transaction `eth_price_usd`,
`value_usd`, `gas_usd`, and existing Memes mint `proceeds_usd` /
`artist_split_usd` together. Mint totals are recalculated only for affected direct
mint or subscription-redemption inputs; secondary transfers do not trigger it.
The correction interval extends through the next
existing sample, capped at the invocation's start. ETH amounts, mint counts,
payment details, and other transaction fields remain unchanged. A failure rolls
back the whole chunk, leaving its gap discoverable for another attempt.

Transaction persistence re-reads the applicable price inside the same
REPEATABLE READ transaction with a locking range read. A writer that started
before recovery cannot subsequently overwrite corrected rows with cached prices;
late-arriving/replayed transactions also receive the applicable saved price.
No-price lookups preserve incoming USD fields. Transaction dates are normalized
to the existing whole-second DATETIME precision before lookup and persistence.
Memes mint initialization locks its transaction inputs while calculating and
inserting totals, so it cannot publish an aggregate calculated before correction
after the repair has committed. Lock conflicts fail and retry through the loops'
existing failure paths; NextGen retains its existing database lock retry wrapper.

Existing API consumers read these same tables. Their existing cache lifetimes
still apply; this flow does not change response formats or forcibly invalidate
all API caches. There are no new help-bot routes, public-data surfaces, or product
interaction rules.

## Reset

`ETH_PRICE_RESET=true` still means historical upserts, **never truncate/delete**.
A reset requests five-minute closes from October 1, 2021 through a fixed recent
closed interval. Exact timestamp collisions are updated; existing off-grid live
samples are retained. The same transaction and mint USD correction runs after
these upserts.

A resumable cursor is stored without an expiry in the existing Redis service at
`eth-price:coinbase-reset:v1:<environment>:<DB_HOST>:<DB_NAME>`. It advances only after the
corresponding database transaction commits. A partial/empty response advances the
reset scan after real samples commit and absent closes are recorded for retry;
scan completion is not a claim that all historical data exists. Failed or
ambiguous checkpoint writes
can replay an already committed chunk safely. Reset requires Redis; ordinary gap
recovery and live collection still run when Redis is unavailable.

An unfinished reset continues on subsequent scheduled invocations even if the
flag is cleared. Leaving the flag true after completion does not repeatedly
restart history. To request another completed reset, allow an invocation to see
false before setting it true again. The flag is not an abort switch. If Redis
loses the checkpoint, setting the flag true restarts the historical upserts; if
it was already cleared, reassert it to restart. Ordinary coverage recovery does
not depend on the reset cursor and continues independently. Retry cooldowns use
`eth-price:coinbase-unavailable:v1:<environment>:<DB_HOST>:<DB_NAME>` with a
24-hour expiry. The environment is `SENTRY_ENVIRONMENT`, then `NODE_ENV` (or
`local`). During Redis outages, normal recovery/live collection continue with
warm-process cooldowns; a cold start or lost cache can retry unavailable history
sooner. Reset arming is logged explicitly.
Within a warm process, failed/disconnected Redis writes remain pending and take
precedence over stale or empty reads. Subsequent reads retry those writes, using
the original cooldown expiry times. Once a write is acknowledged, normal Redis
reads are authoritative again, including an operator clearing the saved state.

## Bounds and failures

Across gap recovery and reset, each invocation starts at most eight historical
requests and stops starting chunks after three minutes. The currently running
chunk may finish beyond that budget. Each repair database transaction has a
90-second total budget, 30-second statement limit, and five-second lock wait.
Budget exhaustion or a deadlock rolls back the entire chunk for a later retry;
do not move mint correction outside the transaction to bypass this safeguard.
If the database work deadline expires before COMMIT, subsequent chunks use
half as many five-minute intervals, down to one. The reduced limit is saved
without expiry in existing Redis at
`eth-price:coinbase-batch-size:v1:<environment>:<DB_HOST>:<DB_NAME>` and applies
to both gap recovery and reset. This lets oversized day-long repairs make
progress as smaller atomic transactions; reset checkpoints each completed batch.
The failed transaction is not immediately replayed, and its error remains visible.
Acquisition, lock conflicts, and ambiguous COMMIT failures do not reduce the size.
The limit stays reduced until an operator removes that Redis key after resolving
the database bottleneck. Redis outages retain the limit in a warm process, but
cold starts without saved state can repeat the larger attempt. A timeout even for
one interval needs database/query investigation; recovery does not skip the
failed data or claim it has been repaired.
Pending batch-size writes likewise retain the smaller local limit until Redis
acknowledges it. Remaining independent gaps in the current invocation immediately
use the reduced window; the failed range still waits for a later invocation.
Every HTTP attempt has a ten-second timeout;
network errors, timeouts, HTTP 429, and server errors get at most three retries
with bounded backoff. Other HTTP errors fail immediately. Live collection is
attempted after recovery regardless of caught history/reset failures.

Errors are logged and thrown after the live attempt, preserving Lambda/Sentry
failure visibility instead of reporting successful recovery. Monitor the
`BACKFILLED`, `ETH PRICE RESET`, and `CURRENT ETH PRICE SAVED` logs, Lambda errors,
latest `eth_price` timestamp, and remaining price gaps. Repeated omitted-candle
warnings mean Coinbase cannot currently provide that history; inspect that range
instead of marking it covered. Large resets deliberately span many invocations.

## Deployment order

Deploy these backend services in order, allowing existing invocations of the
writer versions to finish before activating recovery:

1. `transactionsLoop` (the `memesTransactionsLoop`, `gradientsTransactionsLoop`,
   and `memeLabTransactionsLoop` Lambdas).
2. `nextgenContractLoop`.
3. `nftsLoop`.
4. `ethPriceLoop`.

The first three add persistence guards; the last activates recovery.

Before dispatching `ethPriceLoop`, the deploying operator must record in the
release record that all three writer services above are running the selected
revision and that invocations of their prior versions have drained. Stop the
collector deployment if either condition is unverified. Verify its reserved
concurrency remains **1** (declared in `src/ethPriceLoop/serverless.yaml:22`)
and its VPC egress permits `api.exchange.coinbase.com`. This is an explicit
runbook gate, not an automated cross-service deployment lock.

No API, frontend, or `dbMigrationsLoop` deployment is required. The generic transaction
persistence helper receives the same guard but has no current runtime callers.
Rolling back code does not undo corrected data; preserve the writer guards if
pausing price recovery. Reverting the collector to Mobula restores the unavailable
provider and is not a data rollback.

## Provider references

- [Ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)
- [Candles and request limits](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)
- [Public API rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)
