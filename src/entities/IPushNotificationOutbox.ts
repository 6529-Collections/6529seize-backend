import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PUSH_NOTIFICATION_OUTBOX_TABLE } from '@/constants';

@Entity(PUSH_NOTIFICATION_OUTBOX_TABLE)
export class PushNotificationOutboxEntity {
  @PrimaryColumn({ type: 'bigint' })
  readonly notification_id!: number;

  @Index()
  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
