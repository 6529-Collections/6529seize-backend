import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_RANK_TABLE } from '@/constants';

@Entity(DROP_RANK_TABLE)
export class DropRankEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  @Index()
  readonly last_increased!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly vote!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
}
