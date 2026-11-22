import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  WAVE_RELAY_EVENTS_TABLE,
  WAVE_RELAY_SUBSCRIPTIONS_TABLE
} from '@/constants';

/**
 * 6529.io's drop index reads the 6529 relays (src/wave-drop-index): every
 * drop event they carry, checked as every reader checks it, in the order
 * 6529.io took it in. It is no source of truth: the relays hold the
 * events, and a rebuild reads them again.
 */
@Entity(WAVE_RELAY_EVENTS_TABLE)
@Index('idx_wave_relay_events_wave_seq', ['wave', 'ingest_seq'])
@Index('idx_wave_relay_events_drop_seq', ['drop_id', 'ingest_seq'])
@Index('idx_wave_relay_events_status_seq', ['origin', 'status', 'ingest_seq'])
export class WaveRelayEventEntity {
  // The order 6529.io took events in: the cursor of the index's readers.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly ingest_seq!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly event_id!: string;

  // The relay that gave it first.
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly relay_id!: string;

  // The wave as the event names it: a 6529.io wave id or a chain wave id.
  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly wave!: string;

  // The relay's key for it: a chain WAVE id, a 6529.io UUID's derived one.
  @Index()
  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly wave_key!: string | null;

  // The drop the event is about: a post's own drop (6529.io's id when it
  // was written here, else derived from the event id), the drop it names
  // for an edit, delete or reaction.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Column({ type: 'smallint', nullable: false })
  readonly kind!: number;

  @Index()
  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly author!: string;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly device_key!: string;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly auth_ref!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly seq!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly claimed_time!: number;

  // The signed event as the relay gave it (its body included).
  @Column({ type: 'json', nullable: false })
  readonly event!: unknown;

  // The grant proof it came with.
  @Column({ type: 'json', nullable: false })
  readonly grant_proof!: unknown;

  // 'site': written through 6529.io (device_signed_events holds it);
  // 'relay': written to the relays only.
  @Column({ type: 'varchar', length: 8, nullable: false })
  readonly origin!: string;

  // 'logged', or 'rejected' (it failed a check: status_reason says why);
  // then, for a relay-only event the index writes into 6529.io's drop
  // tables (FEATURE_WAVES_DROP_INDEX_APPLY): 'applied', 'refused' (6529.io's
  // rules said no) or 'failed' (after MAX_APPLY_ATTEMPTS).
  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly status_reason!: string | null;

  // How its grant was checked: 'known' (6529.io holds it), 'signature'
  // (its wallet's, checked here) or 'unverifiable' (a contract wallet's:
  // never written into 6529.io's tables unless 6529.io holds it).
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly grant_check!: string | null;

  // Tries to write a relay-only event into 6529.io's drop tables that
  // failed in a way that may pass.
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly apply_attempts!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly received_at!: number;
}

/** Where 6529.io's subscription to one relay stands in one wave's log. */
@Entity(WAVE_RELAY_SUBSCRIPTIONS_TABLE)
export class WaveRelaySubscriptionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly relay_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, nullable: false })
  readonly wave!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly log_epoch!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly rseq!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
