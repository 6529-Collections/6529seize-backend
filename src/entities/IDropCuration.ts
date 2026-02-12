import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_CURATIONS_TABLE } from '@/constants';

@Entity(DROP_CURATIONS_TABLE)
@Index('idx_drop_curations_wave_drop', ['wave_id', 'drop_id'])
@Index('idx_drop_curations_wave_curator', ['wave_id', 'curator_id'])
@Index('idx_drop_curations_curator', ['curator_id'])
export class DropCurationEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly curator_id!: string;

  @Column({ type: 'bigint', nullable: false, default: 1 })
  readonly curator_rating!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}
