import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IDENTITY_SUBSCRIPTIONS_TABLE } from '@/constants';
import { ActivityEventAction, ActivityEventTargetType } from './IActivityEvent';

@Entity(IDENTITY_SUBSCRIPTIONS_TABLE)
@Index(['subscriber_id', 'target_id', 'target_type', 'target_action'], {
  unique: true
})
export class IdentitySubscriptionEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: bigint;

  @Index('identity_subscription_subscriber_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly subscriber_id!: string;

  @Index('identity_subscription_target_id_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_id!: string;

  @Index('identity_subscription_target_type_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_type!: ActivityEventTargetType;

  @Index('identity_subscription_target_action_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_action!: ActivityEventAction;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;

  @Index()
  @Column({ type: 'boolean', default: false })
  subscribed_to_all_drops!: boolean;
}
