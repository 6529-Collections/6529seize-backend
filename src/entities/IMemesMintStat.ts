import { Column, Entity, PrimaryColumn } from 'typeorm';
import { MEMES_MINT_STATS_TABLE } from '@/constants';

@Entity(MEMES_MINT_STATS_TABLE)
export class MemesMintStat {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'datetime', nullable: true })
  mint_date!: Date | null;

  @Column({ type: 'int' })
  mint_count!: number;

  @Column({ type: 'double' })
  proceeds_eth!: number;

  @Column({ type: 'double' })
  proceeds_usd!: number;

  @Column({ type: 'double' })
  artist_split_eth!: number;

  @Column({ type: 'double' })
  artist_split_usd!: number;
}
