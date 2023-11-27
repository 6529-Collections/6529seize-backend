import {
  LazyDbAccessCompatibleService,
  dbSupplier,
  ConnectionWrapper
} from '../sql-executor';
import { CicRating } from '../entities/ICICRating';
import { CIC_RATINGS_TABLE } from '../constants';
import { AggregatedCicRating } from './rates.types';

export class CicRatingsDb extends LazyDbAccessCompatibleService {
  async getAggregatedCicRatingForProfile(
    profileId: string
  ): Promise<AggregatedCicRating> {
    return this.db
      .execute(
        `select sum(rating) as cic_rating, count(*) as contributor_count from ${CIC_RATINGS_TABLE} where target_profile_id = :profileId and rating != 0`,
        { profileId }
      )
      .then((results) => {
        const result = results[0];
        return {
          cic_rating: result.cic_rating ?? 0,
          contributor_count: result.contributor_count ?? 0
        };
      });
  }

  async getProfilesAggregatedCicRatingForProfile(
    targetProfileId: string,
    raterProfileId: string
  ): Promise<number> {
    return this.db
      .execute(
        `select sum(rating) as cic_rating from ${CIC_RATINGS_TABLE} where target_profile_id = :targetProfileId and rating != 0 and rater_profile_id = :raterProfileId`,
        { raterProfileId, targetProfileId }
      )
      .then((results) => results[0].cic_rating ?? 0);
  }

  async lockCicRating({
    raterProfileId,
    targetProfileId,
    connectionHolder
  }: {
    raterProfileId: string;
    targetProfileId: string;
    connectionHolder: ConnectionWrapper<any>;
  }): Promise<CicRating> {
    const maybeCicRating = await this.db
      .execute(
        `select * from ${CIC_RATINGS_TABLE} where rater_profile_id = :raterProfileId and target_profile_id = :targetProfileId`,
        {
          raterProfileId,
          targetProfileId
        }
      )
      .then((results) => results[0] ?? null);
    if (!maybeCicRating) {
      await this.db.execute(
        `insert into ${CIC_RATINGS_TABLE} (rater_profile_id, target_profile_id, rating) values (:raterProfileId, :targetProfileId, 0)`,
        {
          raterProfileId,
          targetProfileId
        },
        { wrappedConnection: connectionHolder.connection }
      );
    }
    return this.db
      .execute(
        `select * from ${CIC_RATINGS_TABLE} where rater_profile_id = :raterProfileId and target_profile_id = :targetProfileId for update`,
        {
          raterProfileId,
          targetProfileId
        },
        { wrappedConnection: connectionHolder.connection }
      )
      .then((results) => results[0]);
  }

  async updateCicRating({
    targetProfileId,
    raterProfileId,
    cicRating,
    connectionHolder
  }: {
    targetProfileId: string;
    raterProfileId: string;
    cicRating: number;
    connectionHolder: ConnectionWrapper<any>;
  }) {
    if (cicRating === 0) {
      await this.db.execute(
        `delete from ${CIC_RATINGS_TABLE} where rater_profile_id = :raterProfileId and target_profile_id = :targetProfileId`,
        {
          raterProfileId,
          targetProfileId
        },
        { wrappedConnection: connectionHolder.connection }
      );
    } else {
      await this.db.execute(
        `update ${CIC_RATINGS_TABLE} set rating = :cicRating where rater_profile_id = :raterProfileId and target_profile_id = :targetProfileId`,
        {
          raterProfileId,
          targetProfileId,
          cicRating
        },
        { wrappedConnection: connectionHolder.connection }
      );
    }
  }
}

export const cicRatingsDb = new CicRatingsDb(dbSupplier);
