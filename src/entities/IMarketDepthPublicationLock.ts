import { Entity, PrimaryColumn } from 'typeorm';
import { MARKET_DEPTH_PUBLICATION_LOCKS_TABLE } from '@/constants/db-tables';

/** One shared row coordinates all current-order snapshot publishers. */
@Entity(MARKET_DEPTH_PUBLICATION_LOCKS_TABLE)
export class MarketDepthPublicationLockEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;
}
