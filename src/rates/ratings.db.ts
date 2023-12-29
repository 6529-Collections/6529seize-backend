import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { RateMatter, Rating } from '../entities/IRating';
import {
  PROFILE_TDHS_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '../constants';
import { DbPoolName } from '../db-query.options';
import { Page, PageRequest } from '../api-serverless/src/page-request';
import { ProfilesMatterRating } from './rates.types';

export class RatingsDb extends LazyDbAccessCompatibleService {
  async getAggregatedRatingOnMatter({
    rater_profile_id,
    matter,
    matter_category,
    matter_target_id
  }: AggregatedRatingRequest): Promise<AggregatedRating> {
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
    return this.db.execute(sql, params, { forcePool: DbPoolName.WRITE }).then(
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
    return this.db
      .execute(sql, params, { forcePool: DbPoolName.WRITE })
      .then((results) => {
        if (!rater_profile_id) {
          return results.map((result: RatingStats) => ({
            ...result,
            rater_contribution: null
          }));
        }
        return results;
      });
  }

  async searchRatingsForMatter({
    matter,
    matter_target_id,
    rater_profile_id,
    page_request,
    order_by,
    order
  }: RatingsSearchRequest): Promise<Page<ProfilesMatterRating>> {
    let sql = `
        with summed_cics as (select matter_target_id as profile_id, sum(rating) as cic_rating from ${RATINGS_TABLE} where matter = 'CIC' group by 1)
    select p.external_id as rater_profile_id, r.matter, r.matter_category, p.handle as rater_handle, r.rating, r.last_modified, case when sc.cic_rating is null then 0 else sc.cic_rating end as rater_cic_rating, p_tdh.boosted_tdh as rater_tdh from ${RATINGS_TABLE} r
      join ${PROFILES_TABLE} p on r.rater_profile_id = p.external_id
      join ${PROFILE_TDHS_TABLE} p_tdh on r.rater_profile_id = p_tdh.profile_id
      left join summed_cics sc on p.external_id = sc.profile_id
      where r.rating <> 0 and r.matter = :matter and r.matter_target_id = :matter_target_id`;
    let countSql = `select count(*) as cnt from ${RATINGS_TABLE} r
      join ${PROFILES_TABLE} p on r.rater_profile_id = p.external_id
      where r.rating <> 0 and r.matter = :matter and r.matter_target_id = :matter_target_id`;
    const params: Record<string, any> = { matter, matter_target_id };
    if (rater_profile_id) {
      params.rater_profile_id = rater_profile_id;
      sql += ' and r.rater_profile_id = :rater_profile_id';
      countSql += ' and r.rater_profile_id = :rater_profile_id';
    }
    const direction = order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const orderBy =
      order_by?.toLowerCase() === 'rating' ? 'rating' : 'last_modified';
    sql += ` order by r.${orderBy} ${direction}`;
    const limit =
      page_request.page_size < 0 ? 0 : Math.min(page_request.page_size, 2000);
    const offset =
      page_request.page < 0
        ? 0
        : (page_request.page - 1) * page_request.page_size;
    sql += ` limit ${limit} offset ${offset}`;

    const [data, count] = await Promise.all([
      this.db.execute(sql, params),
      this.db.execute(countSql, params)
    ]);
    return {
      page: page_request.page,
      next: count > page_request.page_size * page_request.page,
      count: count[0]['cnt'],
      data
    };
  }

  async lockRatingsOnMatterForUpdate({
    rater_profile_id,
    matter
  }: {
    rater_profile_id: string;
    matter: RateMatter;
  }): Promise<Rating[]> {
    return this.db.execute(
      `
          select * from ${RATINGS_TABLE} where rating <> 0 and rater_profile_id = :rater_profile_id and matter = :matter for update
      `,
      {
        rater_profile_id,
        matter
      }
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
      ratingLockRequest,
      { wrappedConnection: connection }
    );
    const allRatesOnMatter: Rating[] = await this.db.execute(
      `
          select * from ${RATINGS_TABLE}
          where rater_profile_id = :rater_profile_id
            and matter = :matter
          for update
      `,
      ratingLockRequest,
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
  }

  public async getOverRateMatters(): Promise<OverRateMatter[]> {
    return this.db.execute(
      `
          with rate_tallies as (select r.rater_profile_id,
                                       r.matter,
                                       sum(r.rating) as tally
                                from ${RATINGS_TABLE} r
                                group by 1, 2)
          select rt.rater_profile_id, rt.matter, rt.tally, pt.boosted_tdh as rater_tdh
          from rate_tallies rt
                   join ${PROFILE_TDHS_TABLE} pt on rt.rater_profile_id = pt.profile_id
          where pt.boosted_tdh < abs(rt.tally);
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
       coalesce(ptdh.boosted_tdh, 0)      as tdh,
       r.rating,
       r.last_modified,
       coalesce(rater_cic_ratings.cic, 0) as cic
from grouped_rates r
         join ${PROFILES_TABLE} p on p.external_id = r.profile_id
         left join ${PROFILE_TDHS_TABLE} ptdh on ptdh.profile_id = r.profile_id
         left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id
         order by 4 desc, 2 desc`,
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
  }): Promise<Page<RatingWithProfileInfo>> {
    const profile_id_field = param.given
      ? 'matter_target_id'
      : 'rater_profile_id';
    const where_profile_id_field =
      profile_id_field === 'rater_profile_id'
        ? 'matter_target_id'
        : 'rater_profile_id';
    const sqlParams = { profile_id: param.profileId, matter: param.matter };
    const limit = param.page_size;
    const offset = (param.page - 1) * param.page_size;
    const sql_start = `with grouped_rates as (select r.${profile_id_field} as profile_id, sum(r.rating) as rating, max(last_modified) as last_modified
                                 from ${RATINGS_TABLE} r
                                 where r.${where_profile_id_field} = :profile_id
                                   and r.matter = :matter
                                   and r.rating <> 0
                                 group by 1),
               rater_cic_ratings as (select matter_target_id as profile_id, sum(rating) as cic
                                     from ${RATINGS_TABLE}
                                     where matter = 'CIC'
                                       and rating <> 0
                                     group by 1) `;
    const [results, count] = await Promise.all([
      this.db.execute(
        `${sql_start} select p.handle                           as handle,
             coalesce(ptdh.boosted_tdh, 0)      as tdh,
             r.rating,
             r.last_modified,
             coalesce(rater_cic_ratings.cic, 0) as cic
      from grouped_rates r
               join ${PROFILES_TABLE} p on p.external_id = r.profile_id
               left join ${PROFILE_TDHS_TABLE} ptdh on ptdh.profile_id = r.profile_id
               left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id order by 3 desc limit ${limit} offset ${offset}`,
        sqlParams
      ),
      this.db
        .execute(
          `${sql_start} select count(*) as cnt
          from grouped_rates r
                   join ${PROFILES_TABLE} p on p.external_id = r.profile_id
                   left join ${PROFILE_TDHS_TABLE} ptdh on ptdh.profile_id = r.profile_id
                   left join rater_cic_ratings on rater_cic_ratings.profile_id = r.profile_id`,
          sqlParams
        )
        .then((results) => results[0]?.cnt ?? 0)
    ]);
    return {
      page: param.page,
      next: count > param.page_size * param.page,
      count: count,
      data: results
    };
  }

  async getRatingsForTargetsOnMatters({
    targetIds,
    matter
  }: {
    targetIds: string[];
    matter: RateMatter;
  }): Promise<{ matter_target_id: string; rating: number }[]> {
    if (!targetIds.length) {
      return [];
    }
    return this.db.execute(
      `
      select matter_target_id, sum(rating) as rating
      from ${RATINGS_TABLE}
      where matter = :matter
        and matter_target_id in (:targetIds)
        and rating <> 0
      group by 1
      `,
      { targetIds, matter }
    );
  }
}

export type UpdateRatingRequest = Omit<Rating, 'last_modified'>;

export interface RatingWithProfileInfo {
  profile_id: string;
  handle: string;
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

export interface RatingsSearchRequest {
  matter: RateMatter;
  matter_target_id: string;
  rater_profile_id: string | null;
  page_request: PageRequest;
  order_by?: string;
  order?: string;
}

export const ratingsDb = new RatingsDb(dbSupplier);
