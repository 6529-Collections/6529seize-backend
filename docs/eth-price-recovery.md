# ETH/USD collection and recovery

`ethPriceLoop` uses the public Coinbase Exchange ETH-USD ticker and historical
candles. It needs no Coinbase key. Mobula is no longer used by this loop;
`ETHERSCAN_API_KEY` retains its unrelated NextGen contract lookup use.

The existing five-minute EventBridge schedule, concurrency of one, and
`eth_price(timestamp_ms, date, usd_price)` schema are unchanged. No entities,
tables, columns, indexes, migrations, API contracts, or frontend changes are
required.

## Normal invocation

1. Fetch and commit the latest trade from `/products/ETH-USD/ticker`, including
   its provider timestamp, before historical database work. Reject nonpositive or
   nonfinite prices, trades over five minutes old, or timestamps more than thirty
   seconds in the future. A failed live database insert stops historical work for
   this invocation; a provider failure still permits historical recovery.
   Initial and periodic live-provider failures remain in the final aggregate
   error even when history completes, preserving visibility of the failed live
   collection. Committed historical progress is retained.
2. Read price coverage on the primary database using two explicit resolutions.
   From **January 1, 2026 UTC onward**, repair interior and trailing gaps at
   five-minute resolution, allowing six minutes thirty seconds between saved
   samples for scheduling jitter. Before that boundary, back to **October 1,
   2021 UTC**, any saved sample in a UTC day covers that day. Only entirely absent
   days need recovery. Existing sparse history and extra rows are preserved.
   New live rows do not hide interior gaps.
3. Process the 2026-and-later gaps first, newest to oldest, then missing older
   days. Fetch up to one day of five-minute candles or thirty daily candles per
   Coinbase page. Split each page into small atomic database batches and commit
   them continuously in the same invocation. There is no one-batch-per-gap or
   eight-batch execution ceiling: the eight-gap discovery limit is only a query
   page size, with a cursor for older gaps.
   Requested closes lie strictly between gap boundaries; existing aligned right
   endpoints are excluded. Off-grid endpoints permit the preceding close, and
   cooldown boundaries preserve the eligible close before an unavailable range.
   Provider failures leave that gap for retry and permit other gaps to proceed.
   Database failures stop historical work immediately. Missing Coinbase closes
   receive a 24-hour cooldown; no price rows are fabricated.
4. Resume a requested reset with the same continuous small-batch processing,
   checkpointing each committed batch. Stop before another unit of work when
   Lambda has at most two minutes left, preserving time for the 90-second repair
   transaction budget, checkpointing, and cleanup. The configured timeout is
   fifteen minutes; the five-minute schedule is not a recovery time limit.
5. Between units of work, refresh the live quote if five minutes have elapsed
   since the previous attempt. Reserved concurrency remains one. Overlapping
   scheduled events can be throttled and retried; all progress is repeatable.

When there are no gaps and no unfinished reset, the only provider request is
for the live ticker (normally 288 requests/day). A long gap can be recovered in
one invocation if its database work fits the available time. Smaller transactions
no longer introduce a five-minute wait between batches. Actual catch-up time
still depends on transaction/mint repair cost and provider availability.

History uses `/products/ETH-USD/candles` with explicit UTC start/end boundaries:
`granularity=300` from 2026 onward and `granularity=86400` for older missing days.
Daily requests use the previous day's closing price at the target UTC midnight,
so they do not use that target day's future close. Daily database batches contain
one candle; normal recovery preserves all existing rows and repairs dependent
values through the next persisted sample. The following page/batch limits apply
to five-minute history. A provider page contains at most 288 closes, below the
300-candle limit. Each database transaction processes at most 12 closes (one hour),
with smaller learned limits applied independently of the provider page size. A candle's close is stored at the **end** of its five-minute
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
before their timestamp. This includes a live quote committed earlier in the same
invocation: if a live tick at 12:08:00.500 lies between closes at 12:05 and 12:10,
whole-second transactions through 12:08:00 use the 12:05 close, those from 12:08:01
through 12:09:59 use the live tick, and those from 12:10 use the later close.
Historical candles do not take precedence over a newer saved live tick. This is
the same timestamp rule used by normal transaction writers.

## Atomic correction of app values

Each chunk commits its price inserts, affected transaction `eth_price_usd`,
`value_usd`, `gas_usd`, and existing Memes mint `proceeds_usd` /
`artist_split_usd` together. Mint totals are recalculated only for affected direct
mint or subscription-redemption inputs; secondary transfers do not trigger it.
The correction interval extends through the next
existing sample, capped at the invocation's start. Recovery reads the persisted
price intervals once (including preserved exact and off-grid samples), then
updates transaction USD values with a constant price in each indexed date range.
It does not run three historical-price subqueries per transaction. Mint candidates
are selected from transactions in the repaired range, then only those existing
mint-stat rows are locked and recalculated. Per-token totals still include that
token's complete mint history. The one-hour database batch bounds repaired candles, not
the number of affected transactions or this full-token aggregation work. ETH amounts, mint counts,
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
A reset requests daily closes at UTC midnight from October 1, 2021 through
December 31, 2025, then five-minute closes from January 1, 2026 through a fixed
recent closed interval. An unfinished legacy five-minute reset checkpoint before
2026 resumes at the containing day's midnight, replaying that day safely at daily
resolution. Reset does not delete finer-grained rows already present. Exact timestamp collisions are updated; existing off-grid live
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
24-hour expiry. Daily omissions use the separate
`eth-price:coinbase-daily-unavailable:v1:<environment>:<DB_HOST>:<DB_NAME>` key;
legacy five-minute omissions cannot suppress an older missing day. The environment is `SENTRY_ENVIRONMENT`, then `NODE_ENV` (or
`local`). During Redis outages, normal recovery/live collection continue with
warm-process cooldowns; a cold start or lost cache can retry unavailable history
sooner. Reset arming is logged explicitly.
Within a warm process, failed/disconnected Redis writes remain pending and take
precedence over stale or empty reads. Subsequent reads retry those writes, using
the original cooldown expiry times. Once a write is acknowledged, normal Redis
reads are authoritative again, including an operator clearing the saved state.

## Bounds and failures

Gap recovery and reset use Lambda's actual remaining execution time. Before
provider requests, discovery pages, and database batches, the collector checks
its two-minute completion reserve. Local calls without a Lambda context use a
fifteen-minute elapsed-time fallback. A fetched page is not a checkpoint: if the
invocation stops mid-page, unprocessed closes remain discoverable and are not
marked unavailable. Each repair database transaction has a
90-second total budget, 30-second statement limit, and five-second lock wait.
Budget exhaustion or a deadlock rolls back the entire chunk for a later retry;
do not move mint correction outside the transaction to bypass this safeguard.
If the database work deadline expires before COMMIT, subsequent chunks use
half as many five-minute intervals, down to one. The reduced limit is saved
without expiry in existing Redis at
`eth-price:coinbase-batch-size:v1:<environment>:<DB_HOST>:<DB_NAME>` and applies
to both five-minute gap recovery and reset. Older daily work uses one daily
candle per transaction. This lets oversized day-long repairs make
progress as smaller atomic transactions; reset checkpoints each completed batch.
The failed transaction is not immediately replayed, and its error remains visible.
Acquisition, lock conflicts, and ambiguous COMMIT failures do not reduce the size.
The effective limit never exceeds one hour, even when Redis contains a larger
value from an earlier deployment. After three consecutive full batches each
complete in under five seconds, the limit doubles up to one hour and is persisted.
Partial/empty or slower batches reset that success streak; failures never trigger
growth. This allows recovery from an old one-candle limit without operator edits.
Redis outages retain the limit in a warm process, but
cold starts without saved state can repeat the larger attempt. A timeout even for
one interval needs database/query investigation; recovery does not skip the
failed data or claim it has been repaired.
Pending batch-size writes retain the latest locally learned limit until Redis
acknowledges it. No further historical database work starts in the failed invocation. The
reduced window applies on the next invocation.
Every HTTP attempt has a ten-second timeout;
network errors, timeouts, HTTP 429, and server errors get at most three retries
with bounded backoff. Other HTTP errors fail immediately. Live collection has already been attempted before recovery. This ordering protects
a saved live row from a later repair rollback, but cannot eliminate contention
from other writers or database cleanup still running from an earlier invocation.

One structured application error summarizes each failed invocation, including
whether live data saved, whether history stopped, attempted chunks, failed ranges,
and safe error codes. Repair failures identify the stage (price insertion,
interval reads, transaction updates, mint selection, or mint totals), with SQL
budget phase/commit outcome when available. SQL text, parameters, and provider
payloads are excluded. The invocation still throws once to preserve Lambda/Sentry
failure visibility; infrastructure alarms remain enabled. Monitor the
`ETH PRICE GAP REPAIR`, `ETH PRICE RESET`, and `CURRENT ETH PRICE SAVED` logs, Lambda errors,
latest `eth_price` timestamp, and remaining price gaps. `PROCESSED CANDLES`
counts provider candles successfully processed by the repair, including any
preserved timestamp collisions; it is not a count of inserted rows. Empty
responses report zero. Confirm restored coverage by reading the database. Repeated omitted-candle
warnings mean Coinbase cannot currently provide that history; inspect that range
instead of marking it covered. The per-run `ETH PRICE RECOVERY SUMMARY` reports
provider pages, committed database batches, processed/omitted candles, discovery
completion, reset status, the next interrupted range, failures, and deadline
status. Scan completion is not proof that deferred provider candles exist.
Large resets can span invocations; each committed batch retains its progress.

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

## Recovery contention follow-up

The contention follow-up changes only `ethPriceLoop`; it keeps the writer guards
introduced by PR #2120. Deploy the follow-up collector only after those writer
versions are installed and drained as described above. There are no schema or
configuration changes and no API/frontend deployment. This is not permission to
skip the original production release group: when completing that rollout, retain
its writer deployments and release-note grouping alongside the follow-up PR.

Before production promotion, check the reported failing range in staging. Confirm
live saves continue, smaller historical batches commit, and no sustained writer
lock waits appear. If failures remain, use the reported repair stage together
with read-only MySQL lock-wait/session evidence and query plans; shrinking time
windows cannot resolve every full-token aggregation or external blocker. Do not
raise SQL budgets or remove atomic correction simply to suppress the errors.
