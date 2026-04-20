import { Column, Entity, PrimaryColumn } from 'typeorm';
import { MEMES_MINT_STATS_TABLE } from '@/constants';

export interface MemesMintStatPaymentDetails {
  payment_address: string;
  has_designated_payee: boolean;
  designated_payee_name: string;
}

@Entity(MEMES_MINT_STATS_TABLE)
export class MemesMintStat {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'datetime', nullable: true })
  mint_date!: Date | null;

  @Column({ type: 'int', name: 'mint_count' })
  total_count!: number;

  @Column({ type: 'int', name: 'direct_mint_count', default: 0 })
  mint_count!: number;

  @Column({ type: 'int', default: 0 })
  subscriptions_count!: number;

  @Column({ type: 'double' })
  proceeds_eth!: number;

  @Column({ type: 'double' })
  proceeds_usd!: number;

  @Column({ type: 'double' })
  artist_split_eth!: number;

  @Column({ type: 'double' })
  artist_split_usd!: number;

  @Column({ type: 'json', nullable: true })
  payment_details!: MemesMintStatPaymentDetails | null;
}
