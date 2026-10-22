import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  VOTING_CREDIT_RELEASES_TABLE,
  VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE
} from '@/constants';
import type { VotingCreditsReturnedNotificationData } from '@/notifications/user-notification.types';

/** A release and its recipients commit with the underlying entry transition. */
@Entity(VOTING_CREDIT_RELEASES_TABLE)
@Index('idx_voting_credit_releases_pending', [
  'completed_at',
  'next_attempt_at'
])
export class VotingCreditReleaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'json' })
  readonly context!: Omit<VotingCreditsReturnedNotificationData, 'amount'>;

  @Column({ type: 'varchar', length: 100, default: '' })
  readonly after_profile_id!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly next_attempt_at!: number;

  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;

  @Column({ type: 'bigint', nullable: true })
  readonly completed_at!: number | null;
}

@Entity(VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE)
export class VotingCreditReleaseRecipientEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly release_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly voter_profile_id!: string;

  @Column({ type: 'bigint' })
  readonly amount!: number;
}
