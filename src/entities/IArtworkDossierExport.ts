import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AD_DOSSIER_EXPORTS } from '@/artwork-documentation/artwork-documentation.tables';

@Entity(AD_DOSSIER_EXPORTS)
@Index('ad_export_queue', ['state', 'lease_until', 'created_at'])
@Index('ad_export_context', ['context_id', 'created_at'])
export class ArtworkDossierExportEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 100 }) actor_profile_id!: string;
  @Column({ type: 'char', length: 64 }) source_sha256!: string;
  @Column({ type: 'varchar', length: 20 }) state!: string;
  @Column({ type: 'json' }) snapshot_json!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) object_version!:
    | string
    | null;
  @Column({ type: 'char', length: 64, nullable: true }) sha256!: string | null;
  @Column({ type: 'bigint', nullable: true }) size_bytes!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) failure_code!:
    | string
    | null;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) expires_at!: number;
  @Column({ type: 'bigint' }) lease_until!: number;
  @Column({ type: 'int' }) attempts!: number;
}
