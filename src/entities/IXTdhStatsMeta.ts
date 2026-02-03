import { Column, Entity, PrimaryColumn } from 'typeorm';
import { XTDH_STATS_META_TABLE } from '@/constants';

@Entity(`${XTDH_STATS_META_TABLE}`)
export class XTdhStatsMetaEntity {
  @PrimaryColumn({ type: 'tinyint' })
  readonly id: number;

  @Column({ type: 'varchar', length: 1, nullable: false })
  readonly active_slot!: 'a' | 'b';

  @Column({ type: 'bigint', nullable: false })
  readonly as_of_midnight_ms!: number;

  @Column({ type: 'datetime', nullable: false })
  readonly last_updated_at!: number;
}
