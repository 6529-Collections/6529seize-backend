import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IDENTITY_NOTIFICATIONS_TABLE } from '../constants';

@Entity(IDENTITY_NOTIFICATIONS_TABLE)
@Index(['identity_id', 'created_at', 'read_at'])
@Index('idx_identity_notifications_read_all', ['identity_id', 'read_at'])
@Index('idx_identity_notifications_read_wave', [
  'wave_id',
  'identity_id',
  'read_at'
])
export class IdentityNotificationEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Index(`${IDENTITY_NOTIFICATIONS_TABLE}_identity_id_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly identity_id!: string;

  @Index(`${IDENTITY_NOTIFICATIONS_TABLE}_additional_identity_id_idx`)
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly additional_identity_id!: string | null;

  @Index(`${IDENTITY_NOTIFICATIONS_TABLE}_related_drop_id_idx`)
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly related_drop_id!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly related_drop_part_no!: number | null;

  @Index(`${IDENTITY_NOTIFICATIONS_TABLE}_related_drop_2_id_idx`)
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly related_drop_2_id!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly related_drop_2_part_no!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly cause!: IdentityNotificationCause;

  @Column({ type: 'json', nullable: false })
  readonly additional_data!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly read_at!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly visibility_group_id!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

export enum IdentityNotificationCause {
  IDENTITY_SUBSCRIBED = 'IDENTITY_SUBSCRIBED',
  IDENTITY_MENTIONED = 'IDENTITY_MENTIONED',
  IDENTITY_REP = 'IDENTITY_REP',
  IDENTITY_NIC = 'IDENTITY_NIC',
  DROP_QUOTED = 'DROP_QUOTED',
  DROP_REPLIED = 'DROP_REPLIED',
  DROP_VOTED = 'DROP_VOTED',
  DROP_REACTED = 'DROP_REACTED',
  DROP_BOOSTED = 'DROP_BOOSTED',
  WAVE_CREATED = 'WAVE_CREATED',
  ALL_DROPS = 'ALL_DROPS',
  PRIORITY_ALERT = 'PRIORITY_ALERT'
}
