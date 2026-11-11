import { Column, Entity, PrimaryColumn } from 'typeorm';
import { COMPETITION_WORKER_CURSORS_TABLE } from '@/constants';

/**
 * Where a competition worker's next pass starts: after the competition it
 * last started. A pass that runs out of time resumes from here, so the
 * competitions after it are not left waiting behind the first ones.
 */
@Entity(COMPETITION_WORKER_CURSORS_TABLE)
export class CompetitionWorkerCursorEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  readonly worker!: string;

  @Column({ type: 'varchar', length: 36 })
  readonly after_id!: string;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
