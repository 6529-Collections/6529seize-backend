import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AD_MUSEUM_RECORDS } from '@/artwork-documentation/artwork-documentation.tables';

@Entity(AD_MUSEUM_RECORDS)
@Index('ad_museum_context_created', ['context_id', 'created_at', 'id'])
@Index('ad_museum_supersession', ['supersedes_id'], { unique: true })
export class ArtworkMuseumRecordEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 100 }) actor_profile_id!: string;
  @Column({ type: 'varchar', length: 40 }) kind!: string;
  @Column({ type: 'varchar', length: 36, nullable: true }) supersedes_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 36, nullable: true }) source_revision_id!:
    | string
    | null;
  @Column({ type: 'int' }) source_draft_version!: number;
  @Column({ type: 'json' }) payload_json!: string;
  @Column({ type: 'char', length: 64 }) sha256!: string;
  @Column({ type: 'bigint' }) created_at!: number;
}
