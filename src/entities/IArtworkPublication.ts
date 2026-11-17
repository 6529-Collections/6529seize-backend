import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AD_PUBLICATIONS } from '@/artwork-documentation/artwork-documentation.tables';

/** One compiled, publicly served IIIF manifest version of an artwork context. */
@Entity(AD_PUBLICATIONS)
@Index('ad_publication_context_version', ['context_id', 'version'], {
  unique: true
})
@Index('ad_publication_state', ['state'])
@Index('ad_publication_reuse', ['context_id', 'source_sha256', 'input_digest'])
export class ArtworkPublicationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 36 }) revision_id!: string;
  @Column({ type: 'varchar', length: 100 }) actor_profile_id!: string;
  @Column({ type: 'int' }) version!: number;
  @Column({ type: 'varchar', length: 20 }) state!: string;
  @Column({ type: 'char', length: 64 }) source_sha256!: string;
  @Column({ type: 'char', length: 64 }) manifest_sha256!: string;
  @Column({ type: 'char', length: 64 }) input_digest!: string;
  @Column({ type: 'varchar', length: 2048 }) manifest_url!: string;
  @Column({ type: 'json' }) input_json!: string;
  @Column({ type: 'json' }) manifest_json!: string;
  @Column({ type: 'varchar', length: 40 }) compiler_version!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) storage_key!:
    | string
    | null;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint', nullable: true }) withdrawn_at!: number | null;
}
