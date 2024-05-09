import { Entity, Column, PrimaryColumn } from 'typeorm';
import { NFTS_TABLE } from '../constants';

@Entity(NFTS_TABLE)
export class NFT {
  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'datetime', nullable: true })
  mint_date!: Date | null;

  @Column({ type: 'int', default: 0 })
  season?: number;

  @Column({ type: 'int', default: 0 })
  edition_size!: number;

  @Column({ type: 'int', default: 0 })
  tdh!: number;
}
