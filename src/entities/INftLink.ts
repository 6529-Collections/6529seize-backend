import { Column, Entity, PrimaryColumn } from 'typeorm';
import { NFT_LINKS_TABLE } from '@/constants';
import type { NormalizedNftCard, Platform } from '@/nft-links/types';

@Entity(NFT_LINKS_TABLE)
export class NftLinkEntity {
  @PrimaryColumn({ type: 'varchar', length: 500 })
  readonly canonical_id!: string;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly platform!: Platform;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly chain!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly contract!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly token!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly custom_id!: string | null;
  @Column({ type: 'json', nullable: true })
  readonly full_data!: NormalizedNftCard | null;
  @Column({ type: 'text', nullable: true })
  readonly media_uri!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly last_error_message!: string | null;
  @Column({ type: 'double', nullable: true })
  readonly price!: number | null;
  @Column({ type: 'bigint', nullable: false })
  readonly last_tried_to_update!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly last_successfully_updated!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly failed_since: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly is_locked_since: number | null;
}
