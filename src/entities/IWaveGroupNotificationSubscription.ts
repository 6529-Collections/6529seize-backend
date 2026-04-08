import { Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE } from '@/constants';

export enum DropGroupMention {
  ALL = 'ALL'
}

@Entity(WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE)
@Index('idx_wave_group_notification_subscriptions_wave_group_identity', [
  'wave_id',
  'mentioned_group',
  'identity_id'
])
export class WaveGroupNotificationSubscriptionEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  identity_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  mentioned_group!: DropGroupMention;
}
