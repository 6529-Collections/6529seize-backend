import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  NOTIFICATION_VIEW_CURSORS_TABLE,
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { IdentityNotificationCause } from './IIdentityNotification';

export enum NotificationViewOrigin {
  /** Derived from source events; a rebuild produces it again. */
  DERIVED = 'DERIVED',
  /** Copied from identity_notifications before its cause was derived. */
  CARRIED = 'CARRIED'
}

/**
 * Notifications as a view over source events. The columns the readers use
 * have the same names as identity_notifications, so its queries run on
 * either table. A row is keyed by its recipient and a deterministic source
 * key, so deriving the same events again writes the same rows.
 */
@Entity(NOTIFICATION_VIEW_TABLE)
@Index('idx_notification_view_identity_id', ['identity_id', 'id'])
@Index('idx_notification_view_unread', ['identity_id', 'read_at'])
@Index('idx_notification_view_wave', ['wave_id', 'identity_id', 'read_at'])
@Index('idx_notification_view_source', ['source_family', 'source_ref'])
@Index('idx_notification_view_seal', ['origin', 'sealed', 'id'])
export class NotificationViewEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly identity_id!: string;

  /** sha256 hex of the source family, reference and recipient. */
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly source_key!: string;

  /** The id clients see: created_at_ms * 4096 + 12 bits of source_key, or the copied row's id. */
  @Column({ type: 'bigint', nullable: false })
  readonly id!: number;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly source_family!: string;

  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly source_ref!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: NotificationViewOrigin;

  /** The identity_notifications row written for this one, while both live. */
  @Index('idx_notification_view_legacy_id')
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly legacy_id!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly additional_identity_id!: string | null;

  @Index('idx_notification_view_related_drop_id')
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly related_drop_id!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly related_drop_part_no!: number | null;

  @Index('idx_notification_view_related_drop_2_id')
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

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly visibility_group_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;

  /** A CARRIED row already written to the notification archive. */
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly sealed!: boolean;
}

/**
 * Where each notification feed, and each one-off pass over old rows, has
 * got to. Ephemeral: losing a cursor replays from the start, and replaying
 * writes the same rows.
 */
@Entity(NOTIFICATION_VIEW_CURSORS_TABLE)
export class NotificationViewCursorEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  readonly source!: string;

  @Column({ type: 'varchar', length: 512, nullable: false })
  readonly cursor_value!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * Pushes of notification_view rows queued in `on` mode, until the scheduled
 * publisher hands them to SQS. Keyed by row, since view ids repeat across
 * people. Ephemeral, like push_notification_outbox_entries.
 */
@Entity(NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE)
export class NotificationViewPushOutboxEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly identity_id!: string;

  @PrimaryColumn({ type: 'char', length: 64 })
  readonly source_key!: string;

  @Index()
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
