import { PROFILE_CMS_POINTER_EVENTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ProfileCmsPointerEventType {
  PUBLISH = 'PUBLISH',
  SET_PRIMARY = 'SET_PRIMARY',
  SUPERSEDE = 'SUPERSEDE',
  ROLLBACK = 'ROLLBACK',
  ARCHIVE = 'ARCHIVE'
}

@Entity(PROFILE_CMS_POINTER_EVENTS_TABLE)
@Index('idx_profile_cms_pointer_events_profile_created', [
  'profile_id',
  'created_at'
])
@Index('idx_profile_cms_pointer_events_package', ['package_db_id'])
export class ProfileCmsPointerEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 25 })
  readonly event_type!: ProfileCmsPointerEventType;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_handle!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly package_db_id!: string;

  @Column({ type: 'varchar', length: 128 })
  readonly package_id!: string;

  @Column({ type: 'int' })
  readonly package_version!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly package_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly payload_hash!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly previous_package_db_id!: string | null;

  @Column({ type: 'varchar', length: 100 })
  readonly actor_profile_id!: string;

  @Column({ type: 'varchar', length: 42, nullable: true, default: null })
  readonly signer_address!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly signature!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly typed_data!: unknown;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly typed_data_hash!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly storage_receipt!: unknown;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
