import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { RateMatter, Rating } from '../entities/IRating';
import {
  COMMUNITY_MEMBERS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  PROFILE_FULL,
  PROFILES_TABLE,
  RATINGS_SNAPSHOTS_TABLE,
  RATINGS_TABLE
} from '../constants';
import { Page } from '../api-serverless/src/page-request';
import { RatingsSnapshot } from '../entities/IRatingsSnapshots';
import { RatingsSnapshotsPageRequest } from './ratings.service';

export class RatingsDb extends LazyDbAccessCompatibleService {
  async getAggregatedRatingOnMatter(
    {
      rater_profile_id,
      matter,
      matter_category,
      matter_target_id
    }: AggregatedRatingRequest,
    connection?: ConnectionWrapper<any>
  ): Promise<AggregatedRating> {
    let sql = `
    select sum(rating) as rating,
    count(distinct rater_profile_id) as contributor_count
    from ${RATINGS_TABLE}
    where 
      rating <> 0 and
      matter = :matter
      and matter_target_id = :matter_target_id
      and matter_category = :matter_category
  `;
    const params: Record<string, any> = {
      matter,
      matter_target_id,
      matter_category
    };
    if (rater_profile_id) {
      sql += ' and rater_profile_id = :rater_profile_id';
      params.rater_profile_id = rater_profile_id;
    }
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(sql, params, opts).then(
      (results) =>
        results[0] ?? {
          rating: 0,
          contributor_count: 0
        }
    );
  }

  async getRatingStatsOnMatterGroupedByCategories({
    rater_profile_id,
    matter,
    matter_target_id
  }: Omit<AggregatedRatingRequest, 'matter_category'>): Promise<RatingStats[]> {
    const sql = `
with general_stats as (select matter_category                  as category,
                          sum(rating)                      as rating,
                          count(distinct rater_profile_id) as contributor_count
                   from ${RATINGS_TABLE}
                   where rating <> 0
                     and matter = :matter
                     and matter_target_id = :matter_target_id
                   group by 1),
 rater_stats as (select matter_category as category,
                        sum(rating)     as rating
                 from ${RATINGS_TABLE}
                 where rating <> 0
                   and matter = :matter
                   and matter_target_id = :matter_target_id
                   and rater_profile_id = :rater_profile_id
                 group by 1)
select general_stats.category,
       general_stats.rating,
       general_stats.contributor_count,
       coalesce(rater_stats.rating, 0) as rater_contribution
from general_stats
         left join rater_stats on general_stats.category = rater_stats.category
  order by 4 desc, 2 desc
  `;
    const params: Record<string, any> = {
      matter,
      matter_target_id,
      rater_profile_id: rater_profile_id ?? '-'
    };
    return this.db.execute(sql, params).then((results) => {
      if (!rater_profile_id) {
        return results.map((result: RatingStats) => ({
          ...result,
          rater_contribution: null
        }));
      }
      return results;
    });
  }

  async lockRatingsOnMatterForUpdate(
    {
      rater_profile_id,
      matter
    }: {
      rater_profile_id: string;
      matter: RateMatter;
    },
    connection: ConnectionWrapper<any>
  ): Promise<Rating[]> {
    return this.db.execute(
      `
          select * from ${RATINGS_TABLE} where rater_profile_id = :rater_profile_id and matter = :matter for update
      `,
      {
        rater_profile_id,
        matter
      },
      { wrappedConnection: connection }
    );
  }

  async getRatingForUpdate(
    ratingLockRequest: UpdateRatingRequest,
    connection: ConnectionWrapper<any>
  ): Promise<Rating & { total_tdh_spent_on_matter: number }> {
    await this.db.execute(
      `
        insert into ${RATINGS_TABLE} (
                                      rater_profile_id,
                                      matter_target_id,
                                      matter, 
                                      matter_category, 
                                      rating,
                                      last_modified
        )
        values (:rater_profile_id, :matter_target_id, :matter, :matter_category, 0, current_time)
        on duplicate key update rater_profile_id = rater_profile_id
    `,
      {
        rater_profile_id: ratingLockRequest.rater_profile_id,
        matter_target_id: ratingLockRequest.matter_target_id,
        matter: ratingLockRequest.matter,
        matter_category: ratingLockRequest.matter_category
      },
      { wrappedConnection: connection }
    );
    const allRatesOnMatter: Rating[] = await this.db.execute(
      `
          select * from ${RATINGS_TABLE}
          where rater_profile_id = :rater_profile_id
            and matter = :matter
            for update
      `,
      {
        rater_profile_id: ratingLockRequest.rater_profile_id,
        matter: ratingLockRequest.matter
      },
      { wrappedConnection: connection }
    );
    const searchedMatter = allRatesOnMatter.find(
      (rate) =>
        rate.matter_category === ratingLockRequest.matter_category &&
        rate.matter_target_id === ratingLockRequest.matter_target_id
    )!;
    const total_tdh_spent_on_matter = allRatesOnMatter.reduce((acc, rate) => {
      return acc + Math.abs(rate.rating);
    }, 0);
    return {
      total_tdh_spent_on_matter,
      ...searchedMatter
    };
  }

  async updateRating(
    ratingUpdate: UpdateRatingRequest,
    amountChanged: number,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
          update ${RATINGS_TABLE}
          set rating = :rating,
              last_modified = current_time
          where rater_profile_id = :rater_profile_id
            and matter = :matter
            and matter_target_id = :matter_target_id
            and matter_category = :matter_category
      `,
      ratingUpdate,
      { wrappedConnection: connection }
    );
    if (ratingUpdate.matter === RateMatter.CIC) {
      await this.db.execute(
        `update ${IDENTITIES_TABLE} set cic = (cic + :amount_changed) where profile_id = :profile_id`,
        {
          profile_id: ratingUpdate.matter_target_id,
          amount_changed: amountChanged
        },
        { wrappedConnection: connection }
      );
    } else if (ratingUpdate.matter === RateMatter.REP) {
      await this.db.execute(
        `update ${IDENTITIES_TABLE} set rep = (rep + :amount_changed), level_raw = (level_raw + :amount_changed) where profile_id = :profile_id`,
        {
          profile_id: ratingUpdate.matter_target_id,
          amount_changed: amountChanged
        },
        { wrappedConnection: connection }
      );
    }
  }

  public async getOverRateMatters(): Promise<OverRateMatter[]> {
    return this.db.execute(
      `
          with rate_tallies as (select r.rater_profile_id,
                                       r.matter,
                                       sum(r.rating) as tally
                                from ${RATINGS_TABLE} r
                                where r.matter in ('REP', 'CIC')
                                group by 1, 2)
          select rt.rater_profile_id, rt.matter, rt.tally, p.profile_tdh as rater_tdh
          from rate_tallies rt
                   left join ${PROFILE_FULL} p on rt.rater_profile_id = p.external_id
          where p.profile_tdh < abs(rt.tally)
      `
    );
  }

  async getRatesSpentOnMatterByProfile(param: {
    profile_id: string;
    matter: RateMatter;
  }): Promise<number> {
    return this.db
      .execute(
        `select sum(abs(rating)) as rating from ${RATINGS_TABLE} where rater_profile_id = :profile_id and matter = :matter`,
        param
      )
      .then((results) => results[0]?.rating ?? 0);
  }

  async getCurrentRatingOnMatterForProfile(
    param: {
      profile_id: string;
      matter_target_id: string;
      matter_category: string;
      matter: RateMatter;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select rating from ${RATINGS_TABLE} where rater_profile_id = :profile_id and matter = :matter and matter_target_id = :matter_target_id and matter_category = :matter_category`,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((results) => results[0]?.rating ?? 0);
  }

  async lockNonZeroRatingsForProfileOlderFirst(
    {
      rater_profile_id,
      page_request
    }: {
      rater_profile_id: string;
      page_request: { page: number; page_size: number };
    },
    connection: ConnectionWrapper<any>
  ): Promise<Rating[]> {
    if (page_request.page < 1 || page_request.page_size <= 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${RATINGS_TABLE} where rater_profile_id = :rater_profile_id and rating <> 0 order by last_modified asc limit :limit offset :offset for update`,
      {
        rater_profile_id,
        offset: (page_request.page - 1) * page_request.page_size,
        limit: page_request.page_size
      },
      { wrappedConnection: connection }
    );
  }

  async lockNonZeroRatingsForMatterAndTargetIdOlderFirst(
    {
      matter_target_id,
      matters,
      page_request
    }: {
      matter_target_id: string;
      matters: RateMatter[];
      page_request: { page: number; page_size: number };
    },
    connection: ConnectionWrapper<any>
  ): Promise<Rating[]> {
    if (
      page_request.page < 1 ||
      page_request.page_size <= 0 ||
      !matters.length
    ) {
      return [];
    }
    return this.db.execute(
      `select * from ${RATINGS_TABLE} where matter_target_id = :matter_target_id and matter in (:matters) and rating <> 0 order by last_modified asc limit :limit offset :offset for update`,
      {
        matter_target_id,
        matters,
        offset: (page_request.page - 1) * page_request.page_size,
        limit: page_request.page_size
      },
      { wrappedConnection: connection }
    );
  }

  async getSummedRatingsOnMatterByTargetIds(param: {
    matter: RateMatter;
    matter_target_ids: string[];
  }): Promise<{ matter_target_id: string; rating: number }[]> {
    if (!param.matter_target_ids.length) {
      return [];
    }
    return this.db.execute(
      `select matter_target_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = :matter and matter_target_id in (:matter_target_ids) group by 1`,
      param
    );
  }

  async getRatingsForMatterAndCategoryOnProfileWithRatersInfo(param: {
    matter_target_id: string;
    matter_category: string;
    matter: RateMatter;
  }): Promise<RatingWithProfileInfo[]> {
    return this.db.execute(
      `
          with grouped_rates as (select r.rater_profile_id as profile_id, sum(r.rating) as rating, max(last_modified) as last_modified
                                 from ${RATINGS_TABLE} r
                                 where r.matter_target_id = :matter_target_id
                                   and r.matter = :matter
                                   and r.matter_category = :matter_category
                                   and r.rating <> 0
                                 group by 1),
               rater_cic_ratings as (select matter_target_id as profile_id, sum(rating) as cic
                                     from ${RATINGS_TABLE}
                                     where matter = 'CIC'
                                       and rating <> 0
                                     group by 1)
          select
              p.external_id as profile_id,
              p.handle                           as handle,
              coalesce(t.boosted_tdh, 0)      as tdh,
              r.rating,
              r.last_modified,
              coalesce(rater_cic_ratings.cic, 0) as cic
          from grouped_rates r
                   join ${PROFILES_TABLE} p on p.external_id = r.profile_id
                   left join ${COMMUNITY_MEMBERS_TABLE} c on p.primary_wallet = c.wallet1 or p.primary_wallet = c.wallet2 or p.primary_wallet = c.wallet3
                   left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = c.consolidation_key
                   left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id
          order by 4 desc, 2 desc
          `,
      param
    );
  }

  async getNumberOfRatersForMatterOnProfile(param: {
    matter: RateMatter;
    profile_id: string;
  }): Promise<number> {
    return this.db
      .execute(
        `select count(distinct rater_profile_id) as cnt from ${RATINGS_TABLE} where matter_target_id = :profile_id and matter = :matter and rating <> 0`,
        param
      )
      .then((results) => results[0]?.cnt ?? 0);
  }

  async getRatingsByRatersForMatter(param: {
    given: boolean;
    profileId: string;
    page: number;
    matter: RateMatter;
    page_size: number;
    order: string;
    order_by: string;
    category: string | null;
  }): Promise<Page<RatingWithProfileInfo>> {
    const profile_id_field = param.given
      ? 'matter_target_id'
      : 'rater_profile_id';
    const where_profile_id_field =
      profile_id_field === 'rater_profile_id'
        ? 'matter_target_id'
        : 'rater_profile_id';
    const sqlParams = {
      profile_id: param.profileId,
      matter: param.matter,
      category: param.category
    };
    const order = param.order;
    const order_by = param.order_by;
    const limit = param.page_size;
    const offset = (param.page - 1) * param.page_size;
    const sql_start = `with grouped_rates as (select r.${profile_id_field} as profile_id, sum(r.rating) as rating, max(last_modified) as last_modified
                                 from ${RATINGS_TABLE} r
                                 where r.${where_profile_id_field} = :profile_id
                                   and r.matter = :matter
                                   and r.rating <> 0
                                   ${
                                     param.category
                                       ? `and r.matter_category = :category`
                                       : ''
                                   }
                                 group by 1),
               rater_cic_ratings as (select matter_target_id as profile_id, sum(rating) as cic
                                     from ${RATINGS_TABLE}
                                     where matter = 'CIC'
                                       and rating <> 0
                                     group by 1) `;
    const [results, count] = await Promise.all([
      this.db.execute(
        `${sql_start} select p.handle                           as handle,
       coalesce(t.boosted_tdh, 0)      as tdh,
       r.profile_id,
       r.rating,
       r.last_modified,
       coalesce(rater_cic_ratings.cic, 0) as cic,
       c.wallet1 as wallet1, 
       c.wallet2 as wallet2, 
       c.wallet3 as wallet3
from grouped_rates r
         join ${PROFILES_TABLE} p on p.external_id = r.profile_id
         left join ${COMMUNITY_MEMBERS_TABLE} c on p.primary_wallet = c.wallet1 or p.primary_wallet = c.wallet2 or p.primary_wallet = c.wallet3
         left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on c.consolidation_key = t.consolidation_key
         left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id order by ${order_by} ${order} ${
          order_by !== `handle` ? `, p.handle asc` : ``
        }  limit ${limit} offset ${offset}`,
        sqlParams
      ),
      this.db
        .execute(
          `${sql_start} select count(*) as cnt
          from grouped_rates r
                   join ${PROFILES_TABLE} p on p.external_id = r.profile_id
                   left join ${COMMUNITY_MEMBERS_TABLE} c on p.primary_wallet = c.wallet1 or p.primary_wallet = c.wallet2 or p.primary_wallet = c.wallet3
                   left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on c.consolidation_key = t.consolidation_key
                   left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id`,
          sqlParams
        )
        .then((results) => results[0]?.cnt ?? 0)
    ]);
    return {
      page: param.page,
      next: count > param.page_size * param.page,
      count: count,
      data: results.map((result) => ({
        ...result,
        wallet1: undefined,
        wallet2: undefined,
        wallet3: undefined,
        wallets: [result.wallet1, result.wallet2, result.wallet3].filter(
          (w) => w
        )
      }))
    };
  }

  async getRatingsForTargetsOnMatters(
    {
      targetIds,
      matter
    }: {
      targetIds: string[];
      matter: RateMatter;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<{ matter_target_id: string; rating: number }[]> {
    if (!targetIds.length) {
      return [];
    }
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `
      select matter_target_id, sum(rating) as rating
      from ${RATINGS_TABLE}
      where matter = :matter
        and matter_target_id in (:targetIds)
        and rating <> 0
      group by 1
      `,
      { targetIds, matter },
      opts
    );
  }

  public async getSnapshotOfAllCicRatings(
    connection: ConnectionWrapper<any>
  ): Promise<RatingSnapshotRow[]> {
    return this.db.execute(
      `
      select
       rater_profile.external_id as rater_profile_id,
       rater_profile.handle as rater_profile,
       target_profile.external_id as target_profile_id,
       target_profile.handle as target_profile,
       r.rating as rating
      from ratings r
               join profiles rater_profile on rater_profile.external_id = r.rater_profile_id
               join profiles target_profile on target_profile.external_id = r.matter_target_id
      where r.matter = :matter
        and r.rating <> 0
      order by 2
      `,
      {
        matter: RateMatter.CIC
      },
      { wrappedConnection: connection }
    );
  }

  public async getSnapshotOfAllRepRatings(
    connection: ConnectionWrapper<any>
  ): Promise<RatingWithCategorySnapshotRow[]> {
    return this.db.execute(
      `
      select
       rater_profile.external_id as rater_profile_id,
       rater_profile.handle as rater_profile,
       target_profile.external_id as target_profile_id,
       target_profile.handle as target_profile,
       r.matter_category as category,
       r.rating as rating
      from ratings r
               join profiles rater_profile on rater_profile.external_id = r.rater_profile_id
               join profiles target_profile on target_profile.external_id = r.matter_target_id
      where r.matter = :matter
        and r.rating <> 0
      order by 2
      `,
      {
        matter: RateMatter.REP
      },
      { wrappedConnection: connection }
    );
  }

  async getLatestSnapshot(
    matter: RateMatter,
    connection: ConnectionWrapper<any>
  ): Promise<RatingsSnapshot | null> {
    return this.db
      .execute(
        `select * from ${RATINGS_SNAPSHOTS_TABLE} where rating_matter = :matter order by snapshot_time desc limit 1`,
        { matter },
        { wrappedConnection: connection }
      )
      .then((results) => results[0] ?? null);
  }

  async insertSnapshot(
    param: {
      snapshot_time: number;
      rating_matter: RateMatter.CIC | RateMatter.REP;
      url: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${RATINGS_SNAPSHOTS_TABLE} (snapshot_time, rating_matter, url) values (:snapshot_time, :rating_matter, :url)`,
      param,
      { wrappedConnection: connection }
    );
  }

  async getRatingsSnapshots(
    pageRequest: RatingsSnapshotsPageRequest
  ): Promise<RatingsSnapshot[]> {
    const limit = pageRequest.page_size;
    const offset = (pageRequest.page - 1) * pageRequest.page_size;
    const params: Record<string, any> = { limit, offset };
    let sql = `select * from ${RATINGS_SNAPSHOTS_TABLE} `;
    if (pageRequest.matter) {
      sql += ` where rating_matter = :matter `;
      params.matter = pageRequest.matter;
    }
    sql += ` order by ${pageRequest.sort} ${pageRequest.sort_direction} limit :limit offset :offset`;
    return this.db.execute(sql, params);
  }

  async countRatingsSnapshots(
    pageRequest: RatingsSnapshotsPageRequest
  ): Promise<number> {
    const params: Record<string, any> = {};
    let sql = `select count(*) as cnt from ${RATINGS_SNAPSHOTS_TABLE} `;
    if (pageRequest.matter) {
      sql += ` where rating_matter = :matter `;
      params.matter = pageRequest.matter;
    }
    return this.db.execute(sql, params).then((results) => results[0]?.cnt ?? 0);
  }

  async getTotalAndUserRepRatingForCategoryToProfile(
    param: {
      category: string | null;
      from_profile_id: string;
      to_profile_id: string;
      matter: RateMatter;
    },
    connection: ConnectionWrapper<any>
  ): Promise<{ total: number; byUser: number }> {
    const [total, byUser] = await Promise.all([
      this.db
        .execute<{ rating: number }>(
          `
      select sum(rating) as rating from ${RATINGS_TABLE} where matter = :matter ${
            param.category ? `and matter_category = :category` : ``
          } and matter_target_id = :to_profile_id
    `,
          param,
          { wrappedConnection: connection }
        )
        .then((results) => results[0]?.rating ?? 0),
      this.db
        .execute<{ rating: number }>(
          `
      select sum(rating) as rating from ${RATINGS_TABLE} where matter = :matter ${
            param.category ? `and matter_category = :category` : ``
          } and matter_target_id = :to_profile_id and rater_profile_id = :from_profile_id
    `,
          param,
          { wrappedConnection: connection }
        )
        .then((results) => results[0]?.rating ?? 0)
    ]);
    return {
      total,
      byUser
    };
  }

  async getRepRating(param: {
    rater_profile_id: string | null;
    target_profile_id: string;
    category: string | null;
  }): Promise<number> {
    const sqlParam: Record<string, any> = {
      target_profile_id: param.target_profile_id
    };
    let sql = `select sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and matter_target_id = :target_profile_id`;
    if (param.rater_profile_id) {
      sqlParam.rater_profile_id = param.rater_profile_id;
      sql += ` and rater_profile_id = :rater_profile_id`;
    }
    if (param.category) {
      sqlParam.category = param.category;
      sql += ` and matter_category = :category`;
    }
    return this.db
      .execute(sql, sqlParam)
      .then((results) => results[0]?.rating ?? 0);
  }

  async getMatterRatingForEachTarget(
    param: {
      matter: RateMatter;
      target_profile_ids: string[];
    },
    connection: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    if (!param.target_profile_ids.length) {
      return {};
    }
    const sql = `select matter_target_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = :matter and matter_target_id in (:target_profile_ids) group by 1`;
    return this.db
      .execute<{ matter_target_id: string; rating: number }>(sql, param, {
        wrappedConnection: connection
      })
      .then((results) =>
        results.reduce((acc, result) => {
          acc[result.matter_target_id] = result.rating;
          return acc;
        }, {} as Record<string, number>)
      );
  }
}

export type UpdateRatingRequest = Omit<Rating, 'last_modified'>;

export interface RatingSnapshotRow {
  readonly rater_profile_id: string;
  readonly rater_profile: string;
  readonly target_profile_id: string;
  readonly target_profile: string;
  readonly rating: number;
}

export interface RatingWithCategorySnapshotRow {
  readonly rater_profile_id: string;
  readonly rater_profile: string;
  readonly target_profile_id: string;
  readonly target_profile: string;
  readonly category: string;
  readonly rating: number;
}

export interface RatingWithProfileInfo {
  profile_id: string;
  handle: string;
  wallets: string[];
  tdh: number;
  rating: number;
  cic: number;
  last_modified: string;
}

export interface OverRateMatter {
  rater_profile_id: string;
  matter: RateMatter;
  tally: number;
  rater_tdh: number;
}

export interface AggregatedRatingRequest {
  rater_profile_id: string | null;
  matter: string;
  matter_category: string;
  matter_target_id: string;
}

export interface AggregatedRating {
  rating: number;
  contributor_count: number;
}

export interface RatingStats {
  category: string;
  rating: number;
  contributor_count: number;
  rater_contribution: number | null;
}

export const ratingsDb = new RatingsDb(dbSupplier);
