import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_CURATIONS_TABLE } from '@/constants';

@Entity(DROP_CURATIONS_TABLE)
@Index('idx_drop_curations_wave_drop', ['wave_id', 'drop_id'])
@Index('idx_drop_curations_wave_curation', ['wave_id', 'curation_id'])
@Index('idx_drop_curations_curation', ['curation_id'])
@Index('idx_drop_curations_curation_priority_order', [
  'curation_id',
  'priority_order'
])
@Index('idx_drop_curations_curated_by', ['curated_by'])
export class DropCurationEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly curation_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly curated_by!: string;

  @Column({ type: 'bigint', nullable: true })
  readonly priority_order!: number | null;
}
