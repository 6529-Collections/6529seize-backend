import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE } from '@/constants';
import { RateMatter } from './IRating';

@Entity(PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE)
@Index(
  'idx_pprcb_action_matter_target_category',
  ['proxy_action_id', 'matter', 'matter_target_id', 'matter_category'],
  { unique: true }
)
@Index('idx_pprcb_action', ['proxy_action_id'])
@Index('idx_pprcb_matter_target', ['matter', 'matter_target_id'])
export class ProfileProxyRatingCreditBalanceEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly proxy_action_id!: string;

  @Column({ type: 'varchar', length: 50 })
  readonly matter!: RateMatter;

  @Column({ type: 'varchar', length: 100 })
  readonly matter_target_id!: string;

  @Column({ type: 'varchar', length: 256 })
  readonly matter_category!: string;

  @Column({ type: 'bigint', default: 0 })
  readonly credit_spent_outstanding!: number;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
