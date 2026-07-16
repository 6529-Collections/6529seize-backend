import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WS_NOTIFICATION_SUBSCRIPTIONS_TABLE } from '@/constants';

@Entity(WS_NOTIFICATION_SUBSCRIPTIONS_TABLE)
export class WSNotificationSubscriptionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly connection_id!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly identity_id!: string;

  @Index()
  @Column({ type: 'bigint', nullable: false })
  readonly jwt_expiry!: number;
}
