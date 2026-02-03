import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { CIC_SCORE_AGGREGATIONS_TABLE } from '@/constants';
import { CicScoreAggregation } from '../entities/ICicScoreAggregation';

export class CicScoreAggregationDb extends LazyDbAccessCompatibleService {
  async upsertForProfile(
    value: CicScoreAggregation,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `INSERT INTO ${CIC_SCORE_AGGREGATIONS_TABLE} (profile_id, score, rater_count)
       VALUES (:profile_id, :score, :rater_count)
       ON DUPLICATE KEY UPDATE score = score + :score, rater_count = rater_count + :rater_count`,
      value,
      { wrappedConnection: connection }
    );
  }
}

export const cicScoreAggregationDb = new CicScoreAggregationDb(dbSupplier);
