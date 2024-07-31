import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IDENTITY_NOTIFICATIONS_TABLE } from '../constants';

@Entity(IDENTITY_NOTIFICATIONS_TABLE)
@Index(['identity_id', 'created_at', 'read_at'])
export class IdentityNotificationEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: bigint;

  @Index(`${IDENTITY_NOTIFICATIONS_TABLE}_identity_id_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly identity_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_type!: IdentityNotificationTargetType;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_action!: IdentityNotificationAction;

  @Column({ type: 'json', nullable: false })
  readonly additional_data!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly read_at!: number | null;
}

export enum IdentityNotificationTargetType {
  IDENTITY = 'IDENTITY',
  DROP = 'DROP'
}

export enum IdentityNotificationAction {
  DROP_REPLIED = 'DROP_REPLIED',
  DROP_VOTED = 'DROP_VOTED',
  SUBSCRIPTION_CREATED = 'SUBSCRIPTION_CREATED'
}
