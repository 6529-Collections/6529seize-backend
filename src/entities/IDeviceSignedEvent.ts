import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DEVICE_SIGNED_EVENTS_TABLE } from '@/constants';

@Entity(DEVICE_SIGNED_EVENTS_TABLE)
@Index('idx_device_signed_events_key_seq', ['device_key', 'seq'], {
  unique: true
})
export class DeviceSignedEventEntity {
  // EIP-712 event id that the device key signed.
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly id!: string;

  @Column({ type: 'smallint', nullable: false })
  readonly kind!: number;

  @Column({ type: 'smallint', nullable: false })
  readonly kind_version!: number;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  // Set only after the write it authorizes has succeeded.
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly author!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly profile_id!: string;

  @Column({ type: 'smallint', nullable: false })
  readonly key_type!: number;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly device_key!: string;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly grant_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly seq!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly anchor!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly claimed_time!: number;

  // JSON array of strings.
  @Column({ type: 'text', nullable: false })
  readonly refs!: string;

  // Canonical JSON exactly as hashed; null when the event has no body.
  @Column({ type: 'mediumtext', nullable: true, default: null })
  readonly body!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly body_hash!: string;

  @Column({ type: 'int', nullable: false })
  readonly body_size!: number;

  @Column({ type: 'varchar', length: 130, nullable: false })
  readonly signature!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
