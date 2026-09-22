import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PUSH_NOTIFICATION_CANCELLATIONS_TABLE } from '@/constants';
@Entity(PUSH_NOTIFICATION_CANCELLATIONS_TABLE)
export class PushNotificationCancellationEntity {
  @PrimaryColumn({ type: 'bigint' })
  readonly notification_id!: number;
  @Index()
  @Column({ type: 'bigint' })
  readonly cancelled_at!: number;
}
