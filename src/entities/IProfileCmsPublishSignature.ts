import { PROFILE_CMS_PUBLISH_SIGNATURES_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(PROFILE_CMS_PUBLISH_SIGNATURES_TABLE)
@Index('idx_profile_cms_publish_signatures_hash', ['typed_data_hash'], {
  unique: true
})
@Index('idx_profile_cms_publish_signatures_profile_created', [
  'profile_id',
  'created_at'
])
export class ProfileCmsPublishSignatureEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  typed_data_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  package_db_id!: string;

  @Column({ type: 'varchar', length: 128 })
  package_id!: string;

  @Column({ type: 'int' })
  package_version!: number;

  @Column({ type: 'varchar', length: 100 })
  package_hash!: string;

  @Column({ type: 'varchar', length: 42 })
  signer_address!: string;

  @Column({ type: 'bigint' })
  deadline!: number;

  @Column({ type: 'bigint' })
  created_at!: number;
}
