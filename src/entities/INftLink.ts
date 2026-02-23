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
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly media_preview_status!: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly media_preview_kind!: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly media_preview_source_hash!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly media_preview_card_url!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly media_preview_thumb_url!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly media_preview_small_url!: string | null;
  @Column({ type: 'int', nullable: true })
  readonly media_preview_width!: number | null;
  @Column({ type: 'int', nullable: true })
  readonly media_preview_height!: number | null;
  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly media_preview_mime_type!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly media_preview_bytes!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly media_preview_last_tried_at!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly media_preview_last_success_at!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly media_preview_failed_since!: number | null;
  @Column({ type: 'text', nullable: true })
  readonly media_preview_error_message!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly media_preview_locked_since!: number | null;
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
