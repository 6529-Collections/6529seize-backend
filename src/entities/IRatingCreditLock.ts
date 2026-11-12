import { Entity, PrimaryColumn } from 'typeorm';
import { RATING_CREDIT_LOCKS_TABLE } from '@/constants/db-tables';

/**
 * One row per rater and rating matter, holding no data. A rating write that
 * checks the rater's credit locks it first (RatingsDb.lockRaterCreditOnMatter).
 */
@Entity(RATING_CREDIT_LOCKS_TABLE)
export class RatingCreditLockEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  rater_profile_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 50 })
  matter!: string;
}
