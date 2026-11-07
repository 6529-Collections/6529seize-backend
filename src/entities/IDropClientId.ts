import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_CLIENT_IDS_TABLE } from '@/constants';

/**
 * A client-generated id for one drop creation, unique per author. A retried
 * create with the same id returns the drop it already made (waves R11-5).
 * Kept apart from `drops` so the unique key needs no change to that table.
 */
@Entity(DROP_CLIENT_IDS_TABLE)
export class DropClientIdEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly author_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 36, nullable: false })
  readonly client_drop_id!: string;

  @Index('idx_drop_client_ids_drop_id')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  /** Fingerprint of the create request, so a reused id with new content fails. */
  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly content_fingerprint!: string;

  @Index('idx_drop_client_ids_created_at')
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
