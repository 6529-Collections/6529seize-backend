import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_CLAPPER_STATE_TABLE } from '../constants';

@Entity(DROP_CLAPPER_STATE_TABLE)
@Index(['drop_id', 'claps'])
export class DropClapperStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly clapper_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly claps!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
}
