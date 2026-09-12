import { RELEASE_NOTE_STREAM_STATES_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity(RELEASE_NOTE_STREAM_STATES_TABLE)
export class ReleaseNoteStreamStateEntity {
  @PrimaryColumn({ type: 'char', length: 64, nullable: false })
  readonly stream_key!: string;

  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly repository!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly workflow_id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly branch!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly environment!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly last_completed_run_id!: string;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly last_completed_run_number!: number;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly last_completed_sha!: string;

  @Column({ type: 'int', unsigned: true, nullable: false, default: 0 })
  readonly version!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
