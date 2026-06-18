import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { CMS_PUBLISHED_PACKAGES_TABLE, CMS_SITES_TABLE } from '@/constants';

@Entity(CMS_SITES_TABLE)
@Index('idx_cms_sites_owner_slug', ['owner_profile_id', 'slug'], {
  unique: true
})
@Index('idx_cms_sites_owner_primary', [
  'owner_profile_id',
  'primary_package_hash'
])
export class CmsSiteEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly owner_profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly slug!: string;

  @Column({ type: 'varchar', length: 255 })
  readonly title!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly description!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly primary_package_hash!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly primary_static_path!: string | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  @Column({ type: 'varchar', length: 50 })
  readonly created_by_wallet!: string;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly updated_by_wallet!: string | null;
}

@Entity(CMS_PUBLISHED_PACKAGES_TABLE)
@Index('idx_cms_packages_site_published', ['site_id', 'published_at'])
@Index('idx_cms_packages_owner_path', ['owner_profile_id', 'static_path'])
export class CmsPublishedPackageEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly package_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly payload_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly schema!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly site_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly owner_profile_id!: string;

  @Column({ type: 'varchar', length: 255 })
  readonly title!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly description!: string | null;

  @Column({ type: 'varchar', length: 500 })
  readonly static_path!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly canonical_url!: string | null;

  @Column({ type: 'json', nullable: false })
  readonly package_json!: unknown;

  @Column({ type: 'json', nullable: false })
  readonly storage_json!: unknown;

  @Column({ type: 'json', nullable: false })
  readonly signature_json!: unknown;

  @Column({ type: 'bigint' })
  readonly published_at!: number;

  @Column({ type: 'varchar', length: 50 })
  readonly published_by_wallet!: string;
}
