import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WAVE_RELAY_CURSORS_TABLE } from '@/constants';

/**
 * How far 6529.io has published its device-signed drop events to one 6529
 * relay: the last event published, in (created_at, id) order
 * (src/wave-relay-publish).
 */
@Entity(WAVE_RELAY_CURSORS_TABLE)
export class WaveRelayCursorEntity {
  // The relay's CRP address (ws:// or wss://).
  @PrimaryColumn({ type: 'varchar', length: 255, nullable: false })
  readonly relay!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly last_created_at!: number;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly last_event_id!: string;

  // Events the relay took or already held.
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly published!: number;

  // Events the relay refused for good (logged).
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly rejected!: number;

  // Why the last run stopped early, if it did.
  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
