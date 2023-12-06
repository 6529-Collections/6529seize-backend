import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { RateMatter, Rating } from '../entities/IRating';
import { PROFILE_TDHS_TABLE, RATINGS_TABLE } from '../constants';
import { DbPoolName } from '../db-query.options';

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
    where matter = :matter
      and matter_category = :matter_category
      and matter_target_id = :matter_target_id
  `;
    const params: Record<string, any> = {
      matter,
      matter_category,
      matter_target_id
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
          select rt.rater_profile_id, rt.matter, rt.tally, pt.tdh as rater_tdh
          from rate_tallies rt
                   join ${PROFILE_TDHS_TABLE} pt on rt.rater_profile_id = pt.profile_id
          where pt.tdh < abs(rt.tally);
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

  async lockNonZeroRatingsNewerFirst(
    {
      rater_profile_id,
      page_request,
      matter
    }: {
      rater_profile_id: string;
      page_request: { page: number; page_size: number };
      matter: RateMatter;
    },
    connection: ConnectionWrapper<any>
  ): Promise<Rating[]> {
    if (page_request.page < 1 || page_request.page_size <= 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${RATINGS_TABLE} where rater_profile_id = :rater_profile_id and matter = :matter and rating <> 0 order by last_modified desc limit :limit offset :offset for update`,
      {
        rater_profile_id,
        matter,
        offset: (page_request.page - 1) * page_request.page_size,
        limit: page_request.page_size
      },
      { wrappedConnection: connection }
    );
  }
}

export type UpdateRatingRequest = Omit<Rating, 'last_modified'>;

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

export const ratingsDb = new RatingsDb(dbSupplier);
