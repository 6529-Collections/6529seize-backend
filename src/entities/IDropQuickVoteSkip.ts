import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_QUICKVOTE_SKIPS_TABLE } from '@/constants';

@Entity(DROP_QUICKVOTE_SKIPS_TABLE)
@Index('idx_drop_quickvote_skips_identity_wave_skipped_at', [
  'identity_id',
  'wave_id',
  'skipped_at'
])
export class DropQuickVoteSkipEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly identity_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'bigint' })
  readonly skipped_at!: number;
}
