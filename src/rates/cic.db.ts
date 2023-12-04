import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { CicRating } from '../entities/ICICRating';
import { CIC_RATINGS_TABLE, CIC_STATEMENTS_TABLE } from '../constants';
import { AggregatedCicRating } from './rates.types';
import { CicStatement } from '../entities/ICICStatement';
import { uniqueShortId } from '../helpers';
import { DbPoolName } from '../db-query.options';

export class CicDb extends LazyDbAccessCompatibleService {
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
        `insert into ${CIC_RATINGS_TABLE} (rater_profile_id, target_profile_id, rating)
         values (:raterProfileId, :targetProfileId, 0)`,
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
        `update ${CIC_RATINGS_TABLE}
         set rating = :cicRating
         where rater_profile_id = :raterProfileId
           and target_profile_id = :targetProfileId`,
        {
          raterProfileId,
          targetProfileId,
          cicRating
        },
        { wrappedConnection: connectionHolder.connection }
      );
    }
  }

  async insertCicStatement(
    newCicStatement: Omit<CicStatement, 'id' | 'crated_at'>
  ): Promise<CicStatement> {
    const id = uniqueShortId();
    await this.db.execute(
      `
          insert into ${CIC_STATEMENTS_TABLE}
          (id, profile_id, statement_group, statement_type, statement_comment, statement_value, crated_at)
          values (:id, :profile_id, :statement_group, :statement_type, :statement_comment, :statement_value, current_time)
      `,
      {
        id: id,
        ...newCicStatement
      }
    );
    return (await this.getCicStatementByIdAndProfileId({
      id,
      profile_id: newCicStatement.profile_id
    }))!;
  }

  async deleteCicStatement(props: { profile_id: string; id: string }) {
    await this.db.execute(
      `delete from ${CIC_STATEMENTS_TABLE} where id = :id and profile_id = :profile_id`,
      props
    );
  }

  async getCicStatementByIdAndProfileId(props: {
    profile_id: string;
    id: string;
  }): Promise<CicStatement | null> {
    return this.db
      .execute(
        `select * from ${CIC_STATEMENTS_TABLE} where id = :id and profile_id = :profile_id`,
        props,
        { forcePool: DbPoolName.WRITE }
      )
      ?.then((results) => results[0] ?? null);
  }

  async getCicStatementsByProfileId(
    profile_id: string
  ): Promise<CicStatement[]> {
    return this.db.execute(
      `select * from ${CIC_STATEMENTS_TABLE} where profile_id = :profile_id`,
      { profile_id: profile_id },
      { forcePool: DbPoolName.WRITE }
    );
  }
}

export const cicDb = new CicDb(dbSupplier);
