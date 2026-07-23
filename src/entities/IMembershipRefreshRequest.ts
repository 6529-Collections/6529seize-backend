import { MEMBERSHIP_REFRESH_REQUESTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RetryableRefreshRequestEntity } from './IRetryableRefreshRequest';

export enum MembershipRefreshScope {
  PROFILE = 'PROFILE',
  GROUP = 'GROUP'
}

/**
 * Dirty-marking queue for the membership refresh loop. Mirrors the shape of
 * WaveScoreRefreshRequestEntity so the drain logic can be copied 1:1 (dark
 * for now: nothing reads or writes this table yet).
 */
@Entity(MEMBERSHIP_REFRESH_REQUESTS_TABLE)
@Index('idx_mrr_dirty_scope_target', ['dirty_at', 'scope', 'target_id'])
export class MembershipRefreshRequestEntity extends RetryableRefreshRequestEntity {
  @PrimaryColumn({ type: 'varchar', length: 10, nullable: false })
  readonly scope!: MembershipRefreshScope;

  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly target_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly reason!: string;
}
