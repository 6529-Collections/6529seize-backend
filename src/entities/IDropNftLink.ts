import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_NFT_LINKS_TABLE } from '@/constants';

@Entity(DROP_NFT_LINKS_TABLE)
@Index('idx_drop_nft_links_drop_id', ['drop_id'])
@Index('idx_drop_nft_links_canonical_id', ['canonical_id'])
export class DropNftLinkEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 2000, nullable: false })
  readonly url_in_text!: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly canonical_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
