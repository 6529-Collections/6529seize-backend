import { PROFILE_CMS_PACKAGES_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ProfileCmsPackageStatus {
  DRAFT = 'DRAFT',
  VALIDATING = 'VALIDATING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
  ARCHIVED = 'ARCHIVED',
  SUPERSEDED = 'SUPERSEDED'
}

@Entity(PROFILE_CMS_PACKAGES_TABLE)
@Index('idx_profile_cms_packages_profile_state', ['profile_id', 'status'])
@Index('idx_profile_cms_packages_profile_primary', ['profile_id', 'is_primary'])
@Index('idx_profile_cms_packages_package_version', [
  'profile_id',
  'package_id',
  'version'
])
export class ProfileCmsPackageEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  @Index('idx_profile_cms_packages_handle')
  readonly profile_handle!: string;

  @Column({ type: 'varchar', length: 128 })
  readonly package_id!: string;

  @Column({ type: 'int' })
  readonly version!: number;

  @Column({ type: 'varchar', length: 25 })
  readonly status!: ProfileCmsPackageStatus;

  @Column({ type: 'json' })
  readonly cms_package!: unknown;

  @Column({ type: 'varchar', length: 100 })
  readonly payload_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  @Index('idx_profile_cms_packages_package_hash')
  readonly package_hash!: string;

  @Column({ type: 'varchar', length: 512 })
  readonly primary_path!: string;

  @Column({ type: 'boolean', default: false })
  readonly is_primary!: boolean;

  @Column({ type: 'varchar', length: 100 })
  readonly created_by_profile_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly published_by_profile_id!: string | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly validated_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly published_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly failed_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly archived_at!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly superseded_by_id!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly validation_result!: unknown | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly validation_error!: string | null;

  @Column({ type: 'json' })
  readonly storage_receipts!: unknown;

  @Column({ type: 'varchar', length: 25, nullable: true, default: null })
  readonly storage_provider!: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, default: null })
  readonly storage_uri!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly storage_content_hash!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly storage_provider_content_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  readonly storage_recorded_at!: string | null;

  @Column({ type: 'boolean', nullable: true, default: null })
  readonly storage_pinned!: boolean | null;

  @Column({ type: 'boolean', nullable: true, default: null })
  readonly storage_canonical!: boolean | null;
}
