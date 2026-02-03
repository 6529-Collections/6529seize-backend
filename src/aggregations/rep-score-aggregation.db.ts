import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE } from '@/constants';
import { ProfileTotalRepScoreAggregation } from '../entities/IRepScoreAggregations';

export class RepScoreAggregationDb extends LazyDbAccessCompatibleService {
  async getDataForProfiles(
    profileIds: string[]
  ): Promise<ProfileTotalRepScoreAggregation[]> {
    if (!profileIds.length) {
      return [];
    }
    return this.db.execute(
      `SELECT * FROM ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE} WHERE profile_id IN (:profileIds)`,
      { profileIds }
    );
  }

  async upsertForProfile(
    value: ProfileTotalRepScoreAggregation,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `INSERT INTO ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE} (profile_id, score, rater_count)
       VALUES (:profile_id, :score, :rater_count)
       ON DUPLICATE KEY UPDATE score = score + :score, rater_count = rater_count + :rater_count`,
      value,
      { wrappedConnection: connection }
    );
  }
}

export const repScoreAggregationDb = new RepScoreAggregationDb(dbSupplier);
