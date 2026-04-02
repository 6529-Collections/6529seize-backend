import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_SELECTION_DROPS_TABLE, WAVE_SELECTIONS_TABLE } from '@/constants';

@Entity(WAVE_SELECTIONS_TABLE)
@Index('idx_wave_selections_wave_id', ['wave_id'])
@Index('idx_wave_selections_wave_title', ['wave_id', 'title'])
export class WaveSelectionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly id!: string;

  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly title!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(WAVE_SELECTION_DROPS_TABLE)
@Index('idx_wave_selection_drops_wave_id', ['wave_id'])
@Index('idx_wave_selection_drops_drop_id', ['drop_id'])
@Index('idx_wave_selection_drops_selection_wave', ['selection_id', 'wave_id'])
export class WaveSelectionDropEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly selection_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
