import { Entity, Column, PrimaryColumn } from 'typeorm';
import { ETH_PRICE_TABLE } from '../constants';

@Entity(ETH_PRICE_TABLE)
export class EthPrice {
  @PrimaryColumn({ type: 'bigint' })
  timestamp_ms!: number;

  @Column({ type: 'datetime' })
  date!: Date;

  @Column({ type: 'double' })
  usd_price!: number;
}
