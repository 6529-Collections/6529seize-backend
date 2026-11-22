import { PROFILE_CMS_CHAIN_HEADS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The last ProfileDoc version the profile site index applied for a principal.
 * An index of the chain: a rebuild from empty refills it from the change feed.
 */
@Entity(PROFILE_CMS_CHAIN_HEADS_TABLE)
@Index('idx_profile_cms_chain_heads_profile', ['profile_id'])
export class ProfileCmsChainHeadEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly principal!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'int' })
  readonly doc_version!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly doc_cid!: string | null;

  @Column({ type: 'bigint' })
  readonly height!: number;

  /** The `cms.archive` CID whose rows were imported, if any. */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly archive_cid!: string | null;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  /** A later version that could not be applied yet: a document or file was unavailable. */
  @Column({ type: 'int', nullable: true, default: null })
  readonly pending_version?: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly pending_height?: number | null;

  @Column({ type: 'int', default: 0 })
  readonly pending_attempts?: number;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly pending_reason?: string | null;
}
