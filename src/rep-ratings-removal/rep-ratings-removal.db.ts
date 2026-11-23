import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  EVENTS_TABLE,
  IDENTITIES_TABLE,
  PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE,
  REP_RATING_REMOVALS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import {
  chunkSqlInListValues,
  SQL_IN_LIST_CHUNK_BYTES,
  sqlInListBytes
} from '@/db/sql-in-list-chunks';
import { EventType } from '@/entities/IEvent';
import { WaveCreditType } from '@/entities/IWave';
import { aggregateScoresAndCountsByTarget } from '@/rateEventProcessingLoop/aggregations.helper';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RateMatter } from '@/entities/IRating';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

const mysql = require('mysql2');

/** Handles 6529.io gives profiles it makes for rated wallets. */
const PLACEHOLDER_HANDLE_PATTERN = 'id-0x%';

/** One rater's REP ratings in one category. */
const IN_CATEGORY = `r.matter = '${RateMatter.REP}'
  and r.rater_profile_id = :rater_profile_id
  and r.matter_category = :matter_category`;

/** The target's handle (null when it has no identity), for classifying it. */
const TARGET_HANDLE = `(select max(i.normalised_handle) from ${IDENTITIES_TABLE} i
  where i.profile_id = r.matter_target_id)`;

/**
 * Profiles with a vote on an active entry of an active, published competition
 * whose votes are paid with REP: the only voters a REP removal can affect.
 * Category and creditor are left to the reconciliation, which checks them.
 */
const ACTIVE_REP_VOTERS = `select v.voter_profile_id
  from ${COMPETITIONS_TABLE} c
  join ${COMPETITION_VOTES_TABLE} v on v.competition_id = c.id
  join ${COMPETITION_ENTRIES_TABLE} e
    on e.id = v.entry_id and e.competition_id = v.competition_id
  where c.execution_mode = 'ACTIVE'
    and c.lifecycle = 'PUBLISHED'
    and json_unquote(json_extract(c.voting_config, '$.credit_type')) = '${WaveCreditType.REP}'
    and e.status = 'ACTIVE'`;

/**
 * The category of a log row, compared exactly. The column's collation
 * ignores case and accents, but rating categories are exact (utf8_bin):
 * `Artist` must not match `artist`.
 */
const LOG_CATEGORY = 'additional_data_2 collate utf8mb4_bin';

/** The rater's REP rating log rows in the categories. */
const RATER_LOGS = `profile_id = :rater_profile_id
  and additional_data_1 = '${RateMatter.REP}'
  and type = '${ProfileActivityLogType.RATING_EDIT}'
  and ${LOG_CATEGORY} in (:categories)`;

/** Reads whose answer must include the job's own latest writes. */
const ON_PRIMARY = { forcePool: DbPoolName.WRITE };

/** Where a read runs: the primary for checks of the job's own writes. */
export type ReadPool = 'PRIMARY' | 'READER';

function readOptions(pool: ReadPool) {
  return pool === 'PRIMARY' ? ON_PRIMARY : undefined;
}

export interface CategoryScope {
  /** The rater's ratings in the category, zero or not. */
  readonly ratings: number;
  readonly nonZeroRatings: number;
  /** Sum of their values: the REP the targets lose. */
  readonly repSum: number;
  /** Targets whose identity has a handle that is not `id-0x...`. */
  readonly realHandle: number;
  /** Targets whose identity has an `id-0x...` handle. */
  readonly placeholderHandle: number;
}

export interface Totals {
  readonly ratings: number;
  readonly repSum: number;
}

export interface RemovalTotals extends Totals {
  /** Removal records whose target is not recomputed yet. */
  readonly notRecomputed: number;
}

export interface RemovalRow {
  readonly rater_profile_id: string;
  readonly matter_category: string;
  readonly matter_target_id: string;
  readonly old_rating: number;
  readonly removed_at: number;
}

export interface RepScoreDelta {
  readonly profile_id: string;
  readonly score: number;
  readonly rater_count: number;
}

/** What rating events added to one profile's REP score aggregate. */
export interface EventDelta {
  readonly score: number;
  readonly rater_count: number;
}

/** A rating of the rater to a target that votes in an active competition. */
export interface VoterRating {
  readonly matter_target_id: string;
  readonly matter_category: string;
  readonly rating: number;
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function valuesTuple(values: (string | number)[]): string {
  return `(${values.map((it) => mysql.escape(it)).join(', ')})`;
}

/**
 * Groups inlined VALUES tuples so each statement's list stays within the IN
 * list budget, under the RDS Proxy 16 KB pin threshold (sql-in-list-chunks).
 */
function chunkTuples(tuples: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const tuple of tuples) {
    const size = Buffer.byteLength(tuple, 'utf8') + 2;
    if (current.length && bytes + size > SQL_IN_LIST_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(tuple);
    bytes += size;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}

function countsByCategory(
  rows: { matter_category: string; cnt: unknown }[]
): Map<string, number> {
  return new Map(rows.map((row) => [row.matter_category, toNumber(row.cnt)]));
}

/**
 * The reads and writes of the REP ratings removal job that the ratings code
 * has no method for. Every query is bound to one rater and its categories.
 */
export class RepRatingsRemovalDb extends LazyDbAccessCompatibleService {
  async removalsTableExists(): Promise<boolean> {
    const row = await this.db.oneOrNull<{ cnt: number }>(
      `select count(*) as cnt from information_schema.tables
       where table_schema = database() and table_name = :table`,
      { table: REP_RATING_REMOVALS_TABLE },
      ON_PRIMARY
    );
    return toNumber(row?.cnt) > 0;
  }

  async profileExists(profileId: string): Promise<boolean> {
    const row = await this.db.oneOrNull(
      `select 1 as found from ${PROFILES_TABLE} where external_id = :profileId`,
      { profileId },
      ON_PRIMARY
    );
    return !!row;
  }

  /** The profile whose identity has this (lowercase) handle. */
  async findProfileIdByHandle(handle: string): Promise<string | null> {
    const row = await this.db.oneOrNull<{ profile_id: string | null }>(
      `select profile_id from ${IDENTITIES_TABLE}
       where normalised_handle = :handle and profile_id is not null`,
      { handle },
      ON_PRIMARY
    );
    return row?.profile_id ?? null;
  }

  /** The rater's REP ratings in the category, zero or not. */
  async countCategoryRows(
    rater_profile_id: string,
    matter_category: string
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ cnt: number }>(
      `select count(*) as cnt from ${RATINGS_TABLE} r where ${IN_CATEGORY}`,
      { rater_profile_id, matter_category },
      ON_PRIMARY
    );
    return toNumber(row?.cnt);
  }

  async getCategoryScope(
    rater_profile_id: string,
    matter_category: string
  ): Promise<CategoryScope> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select count(*) as ratings,
              coalesce(sum(s.rating <> 0), 0) as non_zero,
              coalesce(sum(s.rating), 0) as rep_sum,
              coalesce(sum(s.handle is not null and lower(s.handle) not like :placeholder), 0) as real_handle,
              coalesce(sum(s.handle is not null and lower(s.handle) like :placeholder), 0) as placeholder_handle
       from (select r.rating, ${TARGET_HANDLE} as handle
             from ${RATINGS_TABLE} r
             where ${IN_CATEGORY}) s`,
      {
        rater_profile_id,
        matter_category,
        placeholder: PLACEHOLDER_HANDLE_PATTERN
      }
    );
    return {
      ratings: toNumber(row?.ratings),
      nonZeroRatings: toNumber(row?.non_zero),
      repSum: toNumber(row?.rep_sum),
      realHandle: toNumber(row?.real_handle),
      placeholderHandle: toNumber(row?.placeholder_handle)
    };
  }

  /** Distinct targets of the rater's ratings in the categories. */
  async countDistinctTargets(
    rater_profile_id: string,
    categories: string[]
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ cnt: number }>(
      `select count(distinct r.matter_target_id) as cnt
       from ${RATINGS_TABLE} r force index (idx_ratings_4)
       where r.matter = '${RateMatter.REP}'
         and r.rater_profile_id = :rater_profile_id
         and r.matter_category in (:categories)`,
      { rater_profile_id, categories }
    );
    return toNumber(row?.cnt);
  }

  /** Other raters' REP ratings in each category: the job leaves them. */
  async countOtherRatersRows(
    rater_profile_id: string,
    categories: string[]
  ): Promise<Map<string, number>> {
    return countsByCategory(
      await this.db.execute<{ matter_category: string; cnt: unknown }>(
        `select r.matter_category, count(*) as cnt
         from ${RATINGS_TABLE} r force index (idx_ratings_3)
         where r.matter = '${RateMatter.REP}'
           and r.matter_category in (:categories)
           and r.rater_profile_id <> :rater_profile_id
         group by r.matter_category`,
        { rater_profile_id, categories }
      )
    );
  }

  /**
   * The rater's REP rating log rows in each category. This reads every one
   * of the rater's REP log rows.
   */
  async countActivityLogs(
    rater_profile_id: string,
    categories: string[],
    pool: ReadPool
  ): Promise<Map<string, number>> {
    return countsByCategory(
      await this.db.execute<{ matter_category: string; cnt: unknown }>(
        `select ${LOG_CATEGORY} as matter_category, count(*) as cnt
         from ${PROFILES_ACTIVITY_LOGS_TABLE}
         where ${RATER_LOGS}
         group by ${LOG_CATEGORY}`,
        { rater_profile_id, categories },
        readOptions(pool)
      )
    );
  }

  /**
   * What the rating events recorded for the rater's ratings in the category
   * added to the profile REP score aggregates, per target, as the rate event
   * listener applied them; and how many events there were. Scans every REP
   * rating event, so it only runs for categories written without events.
   */
  async getRatingEventDeltas(
    rater_profile_id: string,
    matter_category: string
  ): Promise<{ events: number; byTarget: Map<string, EventDelta> }> {
    const rows = await this.db.execute<{
      target_profile_id: string;
      old_score: unknown;
      new_score: unknown;
    }>(
      `select json_unquote(json_extract(data, '$.target_profile_id')) as target_profile_id,
              json_extract(data, '$.old_score') as old_score,
              json_extract(data, '$.new_score') as new_score
       from ${EVENTS_TABLE}
       where type = '${EventType.PROFILE_REP_RATE}'
         and json_unquote(json_extract(data, '$.rater_profile_id')) = :rater_profile_id
         and json_unquote(json_extract(data, '$.category')) = :matter_category
       order by id`,
      { rater_profile_id, matter_category }
    );
    const byTarget = aggregateScoresAndCountsByTarget(
      rows.map((row) => ({
        target_profile_id: row.target_profile_id,
        old_score: toNumber(row.old_score),
        new_score: toNumber(row.new_score)
      }))
    );
    return {
      events: rows.length,
      byTarget: new Map(Object.entries(byTarget))
    };
  }

  /**
   * The rater's positive ratings in the categories to targets that vote in
   * an active REP-credit competition: the only removals that can take votes
   * away.
   */
  async findActiveVoterRatings(
    rater_profile_id: string,
    categories: string[]
  ): Promise<VoterRating[]> {
    const rows = await this.db.execute<VoterRating>(
      `select r.matter_target_id, r.matter_category, r.rating
       from ${RATINGS_TABLE} r
       where r.matter = '${RateMatter.REP}'
         and r.rater_profile_id = :rater_profile_id
         and r.matter_category in (:categories)
         and r.rating > 0
         and r.matter_target_id in (${ACTIVE_REP_VOTERS})
       order by r.matter_target_id, r.matter_category`,
      { rater_profile_id, categories }
    );
    return rows.map((row) => ({ ...row, rating: Number(row.rating) }));
  }

  async getRemaining(
    rater_profile_id: string,
    matter_category: string
  ): Promise<Totals> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select count(*) as ratings, coalesce(sum(r.rating), 0) as rep_sum
       from ${RATINGS_TABLE} r
       where ${IN_CATEGORY}`,
      { rater_profile_id, matter_category },
      ON_PRIMARY
    );
    return {
      ratings: toNumber(row?.ratings),
      repSum: toNumber(row?.rep_sum)
    };
  }

  /** Removal records of the category, across every run. */
  async getRemovalTotals(
    rater_profile_id: string,
    matter_category: string
  ): Promise<RemovalTotals> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select count(*) as ratings,
              coalesce(sum(old_rating), 0) as rep_sum,
              coalesce(sum(recomputed_at is null), 0) as not_recomputed
       from ${REP_RATING_REMOVALS_TABLE}
       where rater_profile_id = :rater_profile_id
         and matter_category = :matter_category`,
      { rater_profile_id, matter_category },
      ON_PRIMARY
    );
    return {
      ratings: toNumber(row?.ratings),
      repSum: toNumber(row?.rep_sum),
      notRecomputed: toNumber(row?.not_recomputed)
    };
  }

  /**
   * The next targets after `after` (binary order, as the key collation) with
   * a rating in the category, zero or not: a covering range of idx_ratings_4
   * (matter, rater, category, target, rating). A plain read; the caller locks
   * the targets it returns.
   */
  async findTargetsAfter(
    {
      rater_profile_id,
      matter_category,
      after,
      limit
    }: {
      rater_profile_id: string;
      matter_category: string;
      after: string;
      limit: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<string[]> {
    const rows = await this.db.execute<{ matter_target_id: string }>(
      `select r.matter_target_id
       from ${RATINGS_TABLE} r force index (idx_ratings_4)
       where ${IN_CATEGORY}
         and r.matter_target_id > :after
       order by r.matter_target_id
       limit :limit`,
      { rater_profile_id, matter_category, after, limit },
      { wrappedConnection: connection }
    );
    return rows.map((it) => it.matter_target_id);
  }

  /**
   * Locks the category's ratings of these targets and reads their values.
   * Read through the primary key (rater, target, matter, category) with every
   * key part fixed or listed, so exactly these rows are locked: no other row,
   * no secondary-index gap. (Without the hint MySQL may choose a secondary
   * index and lock its gaps, which other raters' rating writes on these
   * targets need. A list of whole-key tuples is read by a full table scan at
   * this size, locking every rating.)
   */
  async lockRatings(
    {
      rater_profile_id,
      matter_category,
      targets
    }: { rater_profile_id: string; matter_category: string; targets: string[] },
    connection: ConnectionWrapper<any>
  ): Promise<{ matter_target_id: string; rating: number }[]> {
    const rows: { matter_target_id: string; rating: number }[] = [];
    for (const chunk of chunkSqlInListValues(targets)) {
      const chunkRows = await this.db.execute<{
        matter_target_id: string;
        rating: number;
      }>(
        `select r.matter_target_id, r.rating
         from ${RATINGS_TABLE} r force index (primary)
         where ${IN_CATEGORY}
           and r.matter_target_id in (:targets)
         for update`,
        { rater_profile_id, matter_category, targets: chunk },
        { wrappedConnection: connection }
      );
      chunkRows.forEach((it) =>
        rows.push({
          matter_target_id: it.matter_target_id,
          rating: Number(it.rating)
        })
      );
    }
    return rows;
  }

  /** Deletes the category's ratings of these targets, by primary key. */
  async deleteRatings(
    {
      rater_profile_id,
      matter_category,
      targets
    }: { rater_profile_id: string; matter_category: string; targets: string[] },
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    let deleted = 0;
    for (const chunk of chunkSqlInListValues(targets)) {
      const result = await this.db.execute(
        `delete r from ${RATINGS_TABLE} r force index (primary)
         where ${IN_CATEGORY}
           and r.matter_target_id in (:targets)`,
        { rater_profile_id, matter_category, targets: chunk },
        { wrappedConnection: connection }
      );
      deleted += this.db.getAffectedRows(result);
    }
    return deleted;
  }

  async insertRemovals(
    rows: RemovalRow[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const tuples = rows.map((row) =>
      valuesTuple([
        row.rater_profile_id,
        row.matter_category,
        row.matter_target_id,
        row.old_rating,
        row.removed_at
      ])
    );
    for (const chunk of chunkTuples(tuples)) {
      // A rating removed again (re-created in between) keeps its latest value
      // and is recomputed again.
      await this.db.execute(
        `insert into ${REP_RATING_REMOVALS_TABLE}
           (rater_profile_id, matter_category, matter_target_id, old_rating, removed_at)
         values ${chunk.join(', ')}
         on duplicate key update old_rating = values(old_rating),
                                 removed_at = values(removed_at),
                                 recomputed_at = null`,
        undefined,
        { wrappedConnection: connection }
      );
    }
  }

  /**
   * Adds score and rater-count deltas to the profiles' total REP aggregates,
   * as the rate event loop's profile REP sum listener does for each rating
   * change event (a few statements instead of one per profile).
   */
  async addRepScoreDeltas(
    deltas: RepScoreDelta[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const tuples = deltas.map((delta) =>
      valuesTuple([delta.profile_id, delta.score, delta.rater_count])
    );
    for (const chunk of chunkTuples(tuples)) {
      await this.db.execute(
        `insert into ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE} (profile_id, score, rater_count)
         values ${chunk.join(', ')}
         on duplicate key update score = score + values(score),
                                 rater_count = rater_count + values(rater_count)`,
        undefined,
        { wrappedConnection: connection }
      );
    }
  }

  /** Those of the profiles that vote in an active competition. */
  async findActiveVoters(
    profileIds: string[],
    connection: ConnectionWrapper<any>
  ): Promise<string[]> {
    const voters = new Set<string>();
    for (const chunk of chunkSqlInListValues(profileIds)) {
      const rows = await this.db.execute<{ voter_profile_id: string }>(
        `select distinct a.voter_profile_id
         from (${ACTIVE_REP_VOTERS} and v.voter_profile_id in (:profileIds)) a`,
        { profileIds: chunk },
        { wrappedConnection: connection }
      );
      rows.forEach((it) => voters.add(it.voter_profile_id));
    }
    return Array.from(voters);
  }

  /** Targets of removal records not recomputed yet, in target order. */
  async findNotRecomputedTargets(
    rater_profile_id: string,
    categories: string[],
    limit: number
  ): Promise<string[]> {
    const rows = await this.db.execute<{ matter_target_id: string }>(
      `select distinct matter_target_id
       from ${REP_RATING_REMOVALS_TABLE}
       where rater_profile_id = :rater_profile_id
         and recomputed_at is null
         and matter_category in (:categories)
       order by matter_target_id
       limit :limit`,
      { rater_profile_id, categories, limit },
      ON_PRIMARY
    );
    return rows.map((it) => it.matter_target_id);
  }

  /**
   * Marks the targets' removal records in the categories recomputed, except
   * removals made after the recompute started (`removedBefore`), which it
   * may not have seen. Returns how many it marked.
   */
  async markRecomputed(
    {
      rater_profile_id,
      categories,
      targets,
      recomputedAt
    }: {
      rater_profile_id: string;
      categories: string[];
      targets: string[];
      recomputedAt: number;
    },
    removedBefore: number
  ): Promise<number> {
    let marked = 0;
    // The categories are inlined too: leave room for them in the budget.
    const targetBytes = Math.max(
      1024,
      SQL_IN_LIST_CHUNK_BYTES - sqlInListBytes(categories)
    );
    for (const chunk of chunkSqlInListValues(targets, targetBytes)) {
      const result = await this.db.execute(
        `update ${REP_RATING_REMOVALS_TABLE}
         set recomputed_at = :recomputedAt
         where rater_profile_id = :rater_profile_id
           and matter_category in (:categories)
           and matter_target_id in (:targets)
           and recomputed_at is null
           and removed_at <= :removedBefore`,
        {
          rater_profile_id,
          categories,
          targets: chunk,
          recomputedAt,
          removedBefore
        }
      );
      marked += this.db.getAffectedRows(result);
    }
    return marked;
  }

  /**
   * Deletes up to `limit` of the rater's REP rating log rows in the
   * categories (profile REP history on 6529.io). Returns how many.
   */
  async deleteActivityLogs(
    rater_profile_id: string,
    categories: string[],
    limit: number
  ): Promise<number> {
    const result = await this.db.execute(
      `delete from ${PROFILES_ACTIVITY_LOGS_TABLE}
       where ${RATER_LOGS}
       limit :limit`,
      { rater_profile_id, categories, limit }
    );
    return this.db.getAffectedRows(result);
  }
}

export const repRatingsRemovalDb = new RepRatingsRemovalDb(dbSupplier);
