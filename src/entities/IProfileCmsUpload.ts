import { PROFILE_CMS_UPLOADS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(PROFILE_CMS_UPLOADS_TABLE)
@Index('idx_profile_cms_uploads_quota', ['profile_id', 'updated_at'])
export class ProfileCmsUploadEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly package_db_id!: string;
  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;
  @Column({ type: 'bigint' })
  readonly updated_at!: number;
  @Column({ type: 'varchar', length: 36, nullable: true })
  readonly lease_token!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly lease_until!: number | null;
  @Column({ type: 'json', nullable: true })
  readonly receipt!: unknown;
  @Column({ type: 'json', nullable: true })
  readonly upload_state!: unknown;
}
