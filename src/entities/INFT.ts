import { Entity, Column, PrimaryColumn } from 'typeorm';
import { NFTS_TABLE } from '../constants';

@Entity(NFTS_TABLE)
export class NFT {
  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'text', nullable: true })
  mint_date!: string | undefined;

  @Column({ type: 'int', default: -1 })
  season?: number;

  @Column({ type: 'int', default: -1 })
  edition_size!: number;
}
