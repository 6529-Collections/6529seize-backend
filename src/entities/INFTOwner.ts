import { Column, Entity, PrimaryColumn } from 'typeorm';
import { NFT_OWNERS_TABLE } from '../constants';

@Entity(NFT_OWNERS_TABLE)
export class NFTOwner {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  address!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'int' })
  balance!: number;
}
