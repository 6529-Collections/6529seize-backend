import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  ARTWORK_ASSETS_TABLE,
  ARTWORK_ASSET_QUOTAS_TABLE,
  AssetClass,
  AssetState,
  AssetVisibility,
  ArtworkAssetRole,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

@Entity(ARTWORK_ASSETS_TABLE)
@Index(
  'idx_artwork_asset_request',
  ['context_id', 'uploader_profile_id', 'request_key'],
  { unique: true }
)
@Index('idx_artwork_asset_jobs', ['state', 'next_attempt_at', 'lease_until'])
export class ArtworkDocumentationAssetEntity implements StoredAsset {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 100 }) @Index() context_id!: string;
  @Column({ type: 'varchar', length: 100 }) uploader_profile_id!: string;
  @Column({ type: 'varchar', length: 36 }) request_key!: string;
  @Column({ type: 'varchar', length: 64 }) request_hash!: string;
  @Column({ type: 'varchar', length: 255 }) filename!: string;
  @Column({ type: 'varchar', length: 100 }) declared_mime!: string;
  @Column({ type: 'varchar', length: 20 }) extension!: string;
  @Column({ type: 'varchar', length: 30 }) role!: ArtworkAssetRole;
  @Column({ type: 'varchar', length: 25 }) access_class!: AssetClass;
  @Column({ type: 'varchar', length: 25 })
  intended_visibility!: AssetVisibility;
  @Column({ type: 'varchar', length: 20 }) state!: AssetState;
  @Column({ type: 'bigint' }) size_bytes!: number;
  @Column({ type: 'bigint' }) reserved_bytes!: number;
  @Column({ type: 'varchar', length: 255 }) bucket!: string;
  @Column({ type: 'varchar', length: 500 }) object_key!: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) object_version!:
    | string
    | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) multipart_id!:
    | string
    | null;
  @Column({ type: 'mediumtext' }) parts_json!: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) sha256!:
    | string
    | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) detected_mime!:
    | string
    | null;
  @Column({ type: 'varchar', length: 20 })
  inspection_status!: StoredAsset['inspection_status'];
  @Column({ type: 'varchar', length: 30, nullable: true }) scan_status!:
    | string
    | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) preview_key!:
    | string
    | null;
  @Column({ type: 'int', nullable: true }) width!: number | null;
  @Column({ type: 'int', nullable: true }) height!: number | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) failure_code!:
    | string
    | null;
  @Column({ type: 'tinyint', default: 0 }) referenced!: number;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) updated_at!: number;
  @Column({ type: 'bigint' }) @Index() expires_at!: number;
  @Column({ type: 'bigint', default: 0 }) next_attempt_at!: number;
  @Column({ type: 'bigint', default: 0 }) lease_until!: number;
  @Column({ type: 'int', default: 0 }) attempts!: number;
  @Column({ type: 'mediumtext', nullable: true }) technical_metadata_json!:
    | string
    | null;
  @Column({ type: 'varchar', length: 500, nullable: true })
  validation_report_key!: string | null;
}

/** A mutex row serializes reservations for a context without locking a core entity. */
@Entity(ARTWORK_ASSET_QUOTAS_TABLE)
export class ArtworkDocumentationAssetQuotaEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) context_id!: string;
}
