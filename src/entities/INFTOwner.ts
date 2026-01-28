import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  NFT_OWNERS_CONSOLIDATION_TABLE,
  NFT_OWNERS_SYNC_STATE_TABLE,
  NFT_OWNERS_TABLE
} from '../constants';

class NFTOwnerBase {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  balance!: number;
}

@Entity(NFT_OWNERS_TABLE)
@Index('idx_nft_owners_1', ['wallet', 'contract', 'token_id'])
export class NFTOwner extends NFTOwnerBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int' })
  block_reference!: number;
}

@Entity(NFT_OWNERS_CONSOLIDATION_TABLE)
export class ConsolidatedNFTOwner extends NFTOwnerBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}

@Entity(NFT_OWNERS_SYNC_STATE_TABLE)
export class NftOwnersSyncState {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'bigint', default: 0 })
  block_reference!: number;
}
