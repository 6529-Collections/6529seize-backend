# Database Query Optimization Review (MySQL)

Audience: Back-end engineering team  
Date: 2026-01-23  
Scope: repo-level review of query shapes; no production EXPLAINs or cardinality stats were available.

## How to use this report

For each query below:
1. Run `EXPLAIN ANALYZE` (MySQL 8+) on production-like data.
2. Confirm which index is chosen (or whether there is a filesort/temp table).
3. Apply the lowest-risk changes first (indexes / generated columns / parameterization), then re-measure.

## High-impact optimization opportunities

### 1) `ORDER BY RAND()` full scans (random media)

**Locations**
- `src/db-api.ts:327` (`fetchRandomImage`)
- `src/db-api.ts:1478`..`src/db-api.ts:1482` (`fetchNFTMedia`)

**Current SQL (examples)**
```sql
SELECT scaled,image
FROM nfts
WHERE contract=:memes_contract
ORDER BY RAND()
LIMIT 1;
```
```sql
SELECT id, image, s3_image_scaled as image_compact, NULLIF(animation, '') as animation
FROM rememes
ORDER BY RAND()
LIMIT 100;
```

**Why this is slow**
- `ORDER BY RAND()` forces MySQL to assign a random value to candidate rows and sort them (often a full scan + filesort). This does not scale with table size.

**Recommended changes (no functional change: still “random”)**
- Replace `ORDER BY RAND()` with an index-friendly sampling strategy on a monotonic column (usually `id`) and a selective predicate (here `contract`).
  - Requires/assumes an index like `(contract, id)` on the NFTs tables.
  - Example pattern (approx-uniform, but “random enough” for UI):
    ```sql
    -- pick a random pivot within the contract’s id range, then take the next row
    SELECT id, image, scaled
    FROM nfts
    WHERE contract = :contract
      AND id >= (
        SELECT FLOOR(RAND() * (MAX(id) - MIN(id) + 1)) + MIN(id)
        FROM nfts
        WHERE contract = :contract
      )
    ORDER BY id
    LIMIT 1;
    ```
  - For `LIMIT 100`, use repeated pivots (or a small pre-sampled table/materialized cache refreshed periodically) rather than `RAND()` sorting the full base table.

**Indexes to consider**
- `nfts(contract, id)` and equivalent for `nfts_meme_lab`, `nextgen_tokens`, `rememes` (if `id` exists there).

---

### 2) Functions on filtered columns (`STR_TO_DATE`, `UNIX_TIMESTAMP`, `LOWER`) prevent index usage

**Locations**
- `src/db-api.ts:386` (`fetchUploadsByTable`):
  ```sql
  STR_TO_DATE(date, '%Y%m%d') <= :date
  ```
- `src/db.ts:258`..`src/db.ts:266` (`fetchLatestLabTransactionsBlockNumber`):
  ```sql
  WHERE UNIX_TIMESTAMP(transaction_date) <= :date
  ```
- Case-folding patterns appear in multiple places, e.g. `src/db-api.ts:980` (`fetchEns`), `src/transactionsProcessingLoop/distribution.ts:71`..`:73`, `src/transactionsProcessingLoop/subscriptions.ts:134`..`:137`.

**Why this is slow**
- Wrapping a column in a function generally makes a normal b-tree index unusable for that predicate, pushing the plan toward scans.

**Recommended changes**
- **For string dates (`uploads.date`)**: add a generated persisted DATE (or INT) column and index it, then query that column.
  - Example DDL:
    ```sql
    ALTER TABLE uploads
      ADD COLUMN date_dt DATE
        GENERATED ALWAYS AS (STR_TO_DATE(date, '%Y%m%d')) STORED,
      ADD INDEX uploads_date_dt_idx (date_dt);
    ```
  - Then filter with `date_dt <= :date`.
- **For timestamps**: store `transaction_date` as `DATETIME`/`TIMESTAMP` (if not already), and compare directly:
  - `transaction_date <= FROM_UNIXTIME(:date)` (or pass a `Date`/`DATETIME` parameter and compare directly).
- **For `LOWER(col) = LOWER(:param)` / `LOWER(col) IN (...)`**:
  - Preferred: store values normalized (e.g., lowercase addresses/handles) and query with equality.
  - Alternatively (MySQL 8): add expression indexes:
    ```sql
    CREATE INDEX ens_wallet_lower_idx  ON ens ((LOWER(wallet)));
    CREATE INDEX ens_display_lower_idx ON ens ((LOWER(display)));
    ```
  - Or ensure case-insensitive collation where appropriate so you can drop `LOWER()` entirely.

---

### 3) Substring search over concatenated “wallets” fields (`LIKE '%0x...%'`) is fundamentally unindexable

**Locations**
- `src/db-api.ts:1404` (`getTdhForAddress`)
  ```sql
  SELECT boosted_tdh as tdh
  FROM consolidated_wallets_tdh
  WHERE LOWER(wallets) LIKE :address
  ```
- `src/db-api.ts:1436` (`fetchTDHHistory`) uses repeated `LOWER(wallets) LIKE :walletX`

**Why this is slow**
- `LIKE '%...%'` cannot use a normal index (leading wildcard), so this becomes a scan over `consolidated_wallets_tdh` / `tdh_history` as data grows.

**Recommended changes (same functionality, different physical design)**
- Stop encoding multiple addresses into a single string column for lookup purposes.
- Use the existing mapping table/view (`address_consolidation_key` appears throughout the repo, e.g. `src/db.ts:1551`, `src/api-serverless/src/nextgen/nextgen.db-api.ts:776`) and rewrite lookups as joins on equality:
  ```sql
  SELECT c.boosted_tdh AS tdh
  FROM consolidated_wallets_tdh c
  JOIN address_consolidation_key a
    ON a.consolidation_key = c.consolidation_key
  WHERE a.address = :address;
  ```
- For history queries: join from the mapping table to the history table on `consolidation_key` (or add a `consolidation_key` column to the history table during ingestion, if that pipeline exists).

**Indexes to consider**
- `address_consolidation_key(address, consolidation_key)` (and/or `UNIQUE(address)` if 1:1)
- `consolidated_wallets_tdh(consolidation_key)`
- `tdh_history(consolidation_key, date, block)` (or whatever the final join key becomes)

---

### 4) `LIKE '%...%'` over JSON-ish text (artists → meme card membership)

**Location**
- `src/db-api.ts:401`..`:432` (`fetchArtists`)

**Current SQL shape**
- Builds a disjunction such as:
  ```sql
  WHERE memes LIKE :nft_id0 OR memes LIKE :nft_id1 OR ...
  ```
  where each param is a substring like `%"id": 123%`.

**Why this is slow**
- Leading-wildcard `LIKE` is unindexable and devolves to scans.
- The OR chain can defeat optimizer heuristics and can be very costly as `artists` grows.

**Recommended changes (same semantics, better physical model)**
- Normalize membership into a join table, e.g. `artist_memes(artist_id, token_id)` populated at write-time or via a backfill job:
  - Query becomes an index lookup (`WHERE token_id IN (...)`) instead of a scan.
- If you must keep JSON-in-a-column, store it as a real MySQL `JSON` type and consider a generated column strategy. Note: MySQL indexing for “array contains element” is limited; the join-table approach is usually the best path for performance + flexibility.

**Indexes to consider**
- `artist_memes(token_id, artist_id)` and `artist_memes(artist_id, token_id)`

---

### 5) Transactions processing loops: wide selects + per-row lookups/updates

**Locations**
- `src/transactionsProcessingLoop/distribution.ts:33`..`:37` (fetch candidate transactions)
- `src/transactionsProcessingLoop/distribution.ts:76` (lookup distribution record)
- `src/transactionsProcessingLoop/subscriptions.ts:51`..`:56` (fetch airdrops)
- `src/transactionsProcessingLoop/subscriptions.ts:151`..`:156` (sum historical airdrops)
- `src/transactionsProcessingLoop/subscriptions.ts:192`..`:198` (find next unredeemed subscription)

**Why this is slow**
- `SELECT *` inflates IO and network transfer; these loops often only need a subset of columns.
- The distribution loop does an extra `SELECT` then `UPDATE` per transaction (N round trips), and uses `LOWER(col)` predicates that typically prevent index use.

**Recommended changes**
- Narrow projections to only required columns:
  - For distribution processing, only `transaction, to_address, contract, token_id, token_count, block` are used.
- Add/verify “pipeline” indexes that match the filter + ordering:
  - For the distribution transaction scan:
    - `transactions(from_address, value, block)` (supports `from_address IN (...) AND value > 0 AND block > ? ORDER BY block`)
  - For the subscriptions airdrop scan:
    - `transactions(from_address, value, block)` plus `token_count` if it materially improves selectivity (`token_count > 0`)
  - For historical sum:
    - `transactions(contract, token_id, from_address, value, block)` (supports `block < ?` range)
- For `distribution_normalized` lookups/updates:
  - Ensure a unique key/index on `(wallet, contract, card_id)`; current code expects 0 or 1 row and logs an error on duplicates (`src/transactionsProcessingLoop/distribution.ts:95`..`:99`).
  - Avoid `LOWER()` on these columns by storing normalized lowercase values or adding expression indexes.
- Collapse read+write into a single atomic update:
  - Instead of fetching the row then calculating `newMinted` in JS, do:
    ```sql
    UPDATE distribution_normalized
    SET minted = minted + :delta,
        total_count = total_count + :delta
    WHERE wallet = :wallet AND contract = :contract AND card_id = :card_id;
    ```
  - This reduces round trips and avoids race windows (even inside a transaction, it improves throughput).

---

### 6) Drops “latest with media” query: derived-table aggregation likely computed for the whole table

**Location**
- `src/drops/drops.db.ts:441`..`:466` (`findLatestDropsWithPartsAndMedia`)

**Current SQL shape**
- Joins `drops` to:
  - `drops_parts` (part 1)
  - a derived table that aggregates **all** `drop_media` rows with `drop_part_id=1`:
    ```sql
    LEFT JOIN (
      SELECT drop_id, JSON_ARRAYAGG(...) AS medias_json
      FROM drop_media
      WHERE drop_part_id = 1
      GROUP BY drop_id
    ) dm ON dm.drop_id = d.id
    ```
  - then `ORDER BY d.serial_no DESC LIMIT :limit`

**Why this is slow**
- MySQL frequently materializes the derived table (`GROUP BY drop_id`) before applying the final `LIMIT`, which means work proportional to total `drop_media` size, not just the page size.

**Recommended changes**
- Apply `LIMIT` early (select the latest drop IDs first), then aggregate media only for those IDs.
  - Example approach:
    ```sql
    WITH latest AS (
      SELECT id, wave_id, serial_no
      FROM drops
      WHERE serial_no <= :maxSerialNo
      ORDER BY serial_no DESC
      LIMIT :limit
    )
    SELECT d.*, dp.content, dm.medias_json
    FROM latest
    JOIN drops d ON d.id = latest.id
    LEFT JOIN drops_parts dp
      ON dp.drop_id = d.id AND dp.drop_part_id = 1
    LEFT JOIN (
      SELECT drop_id, JSON_ARRAYAGG(JSON_OBJECT('url', url, 'mime_type', mime_type)) AS medias_json
      FROM drop_media
      WHERE drop_part_id = 1 AND drop_id IN (SELECT id FROM latest)
      GROUP BY drop_id
    ) dm ON dm.drop_id = d.id
    ORDER BY d.serial_no DESC;
    ```
- Indexes to consider:
  - `drops(wave_id, serial_no)` (and/or `drops(serial_no)` depending on access patterns)
  - `drops_parts(drop_id, drop_part_id)`
  - `drop_media(drop_part_id, drop_id)` (supports the filtered aggregation)

---

### 7) Drops phrase search uses both FULLTEXT and `LIKE '%...%'`

**Location**
- `src/drops/drops.db.ts:1555`..`:1566` (`searchDropsContainingPhraseInWave`)

**Current SQL**
```sql
WHERE d.wave_id = :wave_id
  AND MATCH(p.content) AGAINST (:term IN BOOLEAN MODE) > 0
  AND LOWER(p.content) LIKE LOWER(CONCAT('%', :likeTerm, '%')) ESCAPE '\\'
ORDER BY d.created_at DESC
```

**Why this is slow**
- FULLTEXT can be fast, but the additional `LIKE '%...%'` forces a post-filter that can dominate runtime if the FULLTEXT match is broad.
- `LOWER(p.content)` adds extra per-row CPU and can inhibit some optimizations; `LIKE` itself is collation-aware.

**Recommended changes**
- Verify whether FULLTEXT phrase mode alone is sufficient for “contains phrase” semantics; if it is, dropping the `LIKE` yields a big win.
- If the `LIKE` must remain for exact substring semantics:
  - Ensure `p.content` collation is case-insensitive so you can remove `LOWER(...)` and write:
    - `p.content LIKE CONCAT('%', :likeTerm, '%') ESCAPE '\\'`
  - Keep FULLTEXT as the first-stage filter (as you do now), but tune the FULLTEXT index and stopword/min token settings if relevant to your language/content.
- Add/verify indexes:
  - `drops(wave_id, created_at)`
  - `drops_parts(drop_id)` plus `FULLTEXT(drops_parts.content)`

---

### 8) Notifications: COALESCE filter on a left join + visibility ORs

**Locations**
- `src/notifications/identity-notifications.db.ts:162`..`:182` (`findNotifications`)
- `src/notifications/identity-notifications.db.ts:209`..`:224` (`countUnreadNotificationsForIdentity`)

**Current SQL shape (simplified)**
```sql
LEFT JOIN wave_reader_metrics r
  ON r.wave_id = n.wave_id AND r.reader_id = n.identity_id
...
AND COALESCE(r.muted, FALSE) = FALSE
ORDER BY n.id DESC
LIMIT :limit
```

**Why this can be slow**
- `COALESCE(r.muted, FALSE) = FALSE` is harder for the optimizer than an anti-join pattern and can limit index use on `r`.
- The visibility predicate `(visibility_group_id IS NULL OR visibility_group_id IN (...))` is also a common source of suboptimal plans without a supporting index.

**Recommended changes**
- Rewrite “not muted” as an anti-join:
  ```sql
  LEFT JOIN wave_reader_metrics r
    ON r.wave_id = n.wave_id
   AND r.reader_id = n.identity_id
   AND r.muted = TRUE
  WHERE ... AND r.reader_id IS NULL
  ```
  (Semantics stay the same if `muted` is boolean/0/1 with a default of `0`.)
- Indexes to consider:
  - `identity_notifications(identity_id, id)` (hot path: `WHERE identity_id=? ORDER BY id DESC LIMIT ?`)
  - `identity_notifications(identity_id, read_at, id)` (unread counts / unread-only retrieval)
  - `identity_notifications(identity_id, visibility_group_id, id)` (if group visibility filtering is common)
  - `wave_reader_metrics(wave_id, reader_id, muted)`

---

### 9) Owner balances: rank calculation via many scalar `COUNT(DISTINCT ...)` subqueries

**Location**
- `src/api-serverless/src/owners-balances/api.owners-balances.db.ts:66`..`:90` (and similar blocks later in the file)

**Current SQL shape**
```sql
SELECT
  (SELECT COUNT(DISTINCT consolidation_key) + 1 FROM consolidated_owners_balances WHERE total_balance > :ownerTotalBalance) AS total_balance_rank,
  (SELECT COUNT(DISTINCT consolidation_key) + 1 FROM consolidated_owners_balances WHERE memes_balance > :ownerMemesBalance) AS memes_balance_rank,
  ...
FROM dual;
```

**Why this is slow**
- Even with indexes, each `COUNT(...) WHERE metric > :value` tends to scan a large portion of an index range (and you’re doing many of them per request).
- `DISTINCT consolidation_key` is likely unnecessary if the table is 1 row per key; `DISTINCT` can prevent some optimizations.

**Recommended changes**
- If guaranteed 1 row per key: enforce it and drop `DISTINCT`:
  - Add `UNIQUE(consolidation_key)` and change to `COUNT(*)`.
- Prefer precomputed ranks (materialized) in the same consolidated tables produced by your daily pipelines:
  - Compute and store `*_rank` columns once per refresh, not per request.
  - This is usually the biggest win for “leaderboard/rank” features.
- If ranks must be computed on-demand, consider a single window-function query (MySQL 8) that computes multiple ranks in one scan, then filter by key:
  ```sql
  WITH ranked AS (
    SELECT
      consolidation_key,
      DENSE_RANK() OVER (ORDER BY total_balance DESC)    AS total_balance_rank,
      DENSE_RANK() OVER (ORDER BY memes_balance DESC)    AS memes_balance_rank,
      DENSE_RANK() OVER (ORDER BY unique_memes DESC)     AS unique_memes_rank
      -- etc...
    FROM consolidated_owners_balances
  )
  SELECT *
  FROM ranked
  WHERE consolidation_key = :consolidation_key;
  ```
  (This trades “N count queries” for “N window sorts”; precompute remains the best option.)

---

### 10) NextGen trait-set endpoints: unbounded trait fetch + heavy `GROUP_CONCAT(DISTINCT ...)`

**Locations**
- `src/api-serverless/src/nextgen/nextgen.db-api.ts:741`..`:747` (`fetchNextGenCollectionTraitSets`: `SELECT token_id, value FROM nextgen_token_traits WHERE trait=:trait`)
- `src/api-serverless/src/nextgen/nextgen.db-api.ts:749`..`:817` (grouping query with `COUNT(DISTINCT ...)` + `GROUP_CONCAT(DISTINCT ...)`)
- `src/api-serverless/src/nextgen/nextgen.db-api.ts:912`..`:918` (`fetchNextGenCollectionTraitSetsUltimate`: derived-table count + OFFSET pagination)

**Why this is slow**
- The initial `tokenTraits` query is not scoped to the collection and can return a very large result set, then gets filtered in memory.
- `GROUP_CONCAT(DISTINCT ...)` with ordering can force extra temp tables/sorts.
- OFFSET pagination (`OFFSET pageSize*(page-1)`) becomes slower as `page` increases.

**Recommended changes**
- Scope the “token traits” fetch to the collection in SQL:
  ```sql
  SELECT tt.token_id, tt.value
  FROM nextgen_token_traits tt
  JOIN nextgen_tokens t ON t.id = tt.token_id
  WHERE tt.trait = :trait AND t.collection_id = :collectionId;
  ```
- Avoid `LOWER(trait)` in filters by storing `trait` normalized (or adding an expression index).
- Replace `GROUP_CONCAT` + client-side string splitting with `JSON_ARRAYAGG`/`JSON_OBJECTAGG` if you truly need to ship sets of IDs/values (often faster and more robust, and avoids `group_concat_max_len` pitfalls).
- Consider keyset pagination for “browse” endpoints (keep OFFSET only if the API contract requires page numbers).

**Indexes to consider**
- `nextgen_tokens(collection_id, id)` and `nextgen_tokens(owner)`
- `nextgen_token_traits(trait, token_id, value)` (or `(trait, value, token_id)` depending on the most selective predicates)
- `address_consolidation_key(address, consolidation_key)` (used in these joins)

---

### 11) Consolidation resolution via recursive CTE + many `LOWER()` + OR-joins

**Location**
- `src/db.ts:307`..`:350` (`retrieveConsolidationsForWallets`)

**Why this can be slow**
- Multiple `LOWER()` calls and OR join predicates typically block efficient index usage.
- Recursive graph expansion over a large consolidations table can balloon quickly.

**Recommended changes**
- If consolidation keys are already materialized (the repo strongly suggests they are, via `address_consolidation_key` usage and migrations), prefer that mapping table instead of computing clusters on-demand.
- If you must keep the recursive approach:
  - Normalize `wallet1`/`wallet2` to lowercase at write-time and index them.
  - Replace OR-heavy joins with UNION-based expansions to let MySQL use indexes more predictably.

---

### 12) Generic pagination helper: derived-table `COUNT` can dominate runtime

**Location**
- `src/db-api.ts:293`..`:316` (`fetchPaginated`)

**Current SQL shape**
```sql
SELECT COUNT(1) as count
FROM (
  SELECT 1
  FROM <table> <joins> <filters> [GROUP BY ...]
) inner_q
```

**Why this can be slow**
- Counting via a derived table often forces materialization (especially with joins / group by).
- For large tables, `COUNT` can cost more than fetching the page itself.

**Recommended changes**
- For endpoints without `GROUP BY`, prefer a direct count on the base table (and keep joins out of the count unless they are truly filtering rows).
  - You already support this partially with `skipJoinsOnCountQuery` (`src/db-api.ts:291`..`:296`).
- For grouped endpoints, consider counting distinct group keys instead of counting derived rows (often avoids full derived materialization).
- If API consumers only need “has next page”, use the “limit + 1 sentinel” pattern (already used elsewhere in the repo, e.g. `src/profileActivityLogs/profile-activity-logs.db.ts:115`..`:116`) and avoid total counts on hot endpoints. (This is an API contract change; do it selectively.)

## Cross-cutting recommendations (low risk, high ROI)

- Stop using `SELECT *` in hot paths; prefer explicit column lists to reduce row size and enable covering indexes.
- Prefer parameterized queries (avoid string interpolation) to improve plan reuse and reduce parse/optimize overhead. This repo has several interpolated queries (e.g. `src/transactionsProcessingLoop/distribution.ts:71`..`:73`).
- Add/validate composite indexes that match `(filter columns..., order-by column)`; most endpoints are “filter then order then limit”.
- Prefer keyset pagination over OFFSET for high-cardinality tables; OFFSET cost grows with page number.
