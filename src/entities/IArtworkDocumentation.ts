import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  AD_WORKS,
  AD_CONTEXTS,
  AD_ARTISTS,
  AD_ARTIST_REVISIONS,
  AD_SOURCES,
  AD_DROP_LINKS,
  AD_REVISIONS,
  AD_GRANTS,
  AD_PROGRAM_VIEWERS,
  AD_REVIEWS,
  AD_THREADS,
  AD_EVENTS,
  AD_IDEMPOTENCY
} from '@/artwork-documentation/artwork-documentation.tables';

abstract class DocumentationRow {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'bigint' }) created_at!: number;
}
@Entity(AD_WORKS)
@Index('ad_work_owner_updated', ['owner_profile_id', 'updated_at', 'id'])
export class ArtworkDocumentationWorkEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 100 }) owner_profile_id!: string;
  @Column({ type: 'varchar', length: 100 }) creator_profile_id!: string;
  @Column({ type: 'bigint' }) updated_at!: number;
}
@Entity(AD_CONTEXTS)
@Index('ad_context_owner_updated', ['owner_profile_id', 'updated_at', 'id'])
@Index('ad_context_program_lifecycle', [
  'program_id',
  'lifecycle',
  'updated_at'
])
@Index('ad_context_work', ['work_id'])
export class ArtworkDocumentationContextEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36 }) work_id!: string;
  @Column({ type: 'varchar', length: 100 }) owner_profile_id!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) program_id!:
    | string
    | null;
  @Column({ type: 'json' }) profile_json!: string;
  @Column({ type: 'int' }) draft_version!: number;
  @Column({ type: 'varchar', length: 36, nullable: true })
  artist_record_revision_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true }) latest_revision_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 20 }) lifecycle!: string;
  @Column({ type: 'json' }) modules_json!: string;
  @Column({ type: 'json' }) asset_links_json!: string;
  @Column({ type: 'json' }) restricted_paths_json!: string;
  @Column({ type: 'bigint' }) updated_at!: number;
}
@Entity(AD_ARTISTS)
export class ArtworkDocumentationArtistEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) owner_profile_id!: string;
  @Column({ type: 'int', default: 0 }) record_version!: number;
  @Column({ type: 'varchar', length: 36, nullable: true }) latest_revision_id!:
    | string
    | null;
}
@Entity(AD_ARTIST_REVISIONS)
@Index('ad_artist_revision_version', ['owner_profile_id', 'record_version'], {
  unique: true
})
export class ArtworkDocumentationArtistRevisionEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 100 }) owner_profile_id!: string;
  @Column({ type: 'int' }) record_version!: number;
  @Column({ type: 'json' }) answers_json!: string;
  @Column({ type: 'varchar', length: 100 }) actor_profile_id!: string;
}
@Entity(AD_SOURCES)
@Index('ad_source_context', ['context_id'])
export class ArtworkDocumentationSourceEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 100 }) drop_id!: string;
  @Column({ type: 'longtext' }) receipt_text!: string;
  @Column({ type: 'char', length: 64 }) sha256!: string;
  @Column({ type: 'boolean' }) is_excerpt!: boolean;
  @Column({ type: 'varchar', length: 100 }) importer_profile_id!: string;
}
@Entity(AD_DROP_LINKS)
export class ArtworkDocumentationDropLinkEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) drop_id!: string;
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 36 }) work_id!: string;
  @Column({ type: 'varchar', length: 100 }) author_profile_id!: string;
  @Column({ type: 'varchar', length: 100 }) wave_id!: string;
  @Column({ type: 'varchar', length: 36 }) source_receipt_id!: string;
}
@Entity(AD_REVISIONS)
@Index('ad_revision_number', ['context_id', 'revision_number'], {
  unique: true
})
@Index('ad_revision_draft', ['context_id', 'source_draft_version'], {
  unique: true
})
export class ArtworkDocumentationRevisionEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'int' }) revision_number!: number;
  @Column({ type: 'int' }) source_draft_version!: number;
  @Column({ type: 'char', length: 64 }) sha256!: string;
  @Column({ type: 'json' }) snapshot_json!: string;
  @Column({ type: 'json' }) confirmation_json!: string;
}
@Entity(AD_GRANTS)
@Index('ad_grant_subject_scope', [
  'subject_profile_id',
  'context_id',
  'program_id'
])
export class ArtworkDocumentationGrantEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36, nullable: true }) context_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) program_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 100 }) subject_profile_id!: string;
  @Column({ type: 'json' }) capabilities_json!: string;
  @Column({ type: 'varchar', length: 100 }) grantor_profile_id!: string;
  @Column({ type: 'bigint', nullable: true }) revoked_at!: number | null;
}
@Entity(AD_PROGRAM_VIEWERS)
@Index(
  'ad_program_viewer_subject',
  ['program_id', 'subject_type', 'subject_id'],
  {
    unique: true
  }
)
export class ArtworkDocumentationProgramViewerEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 100 }) program_id!: string;
  @Column({ type: 'varchar', length: 10 }) subject_type!: 'profile' | 'group';
  @Column({ type: 'varchar', length: 200 }) subject_id!: string;
  @Column({ type: 'varchar', length: 100 }) grantor_profile_id!: string;
  @Column({ type: 'bigint', nullable: true }) revoked_at!: number | null;
}
@Entity(AD_REVIEWS)
export class ArtworkDocumentationReviewEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) revision_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 30 }) lane!: string;
  @Column({ type: 'int' }) review_version!: number;
  @Column({ type: 'varchar', length: 30 }) status!: string;
  @Column({ type: 'varchar', length: 100, nullable: true })
  reviewer_profile_id!: string | null;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  @Column({ type: 'json', nullable: true }) decision_history_json!:
    | string
    | null;
  @Column({ type: 'bigint' }) updated_at!: number;
}
@Entity(AD_THREADS)
@Index('ad_thread_context', ['context_id', 'created_at'])
export class ArtworkDocumentationThreadEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 100 }) creator_profile_id!: string;
  @Column({ type: 'varchar', length: 30 }) audience!: string;
  @Column({ type: 'varchar', length: 30 }) restricted_class!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) field_path!:
    | string
    | null;
  @Column({ type: 'varchar', length: 36, nullable: true }) revision_id!:
    | string
    | null;
  @Column({ type: 'int' }) thread_version!: number;
  @Column({ type: 'boolean' }) resolved!: boolean;
  @Column({ type: 'json' }) comments_json!: string;
}
@Entity(AD_EVENTS)
@Index('ad_event_context', ['context_id', 'created_at'])
export class ArtworkDocumentationEventEntity extends DocumentationRow {
  @Column({ type: 'varchar', length: 36 }) context_id!: string;
  @Column({ type: 'varchar', length: 100 }) actor_profile_id!: string;
  @Column({ type: 'varchar', length: 100 }) kind!: string;
  @Column({ type: 'json' }) references_json!: string;
}
@Entity(AD_IDEMPOTENCY)
@Index('ad_idempotency_expiry', ['expires_at'])
export class ArtworkDocumentationIdempotencyEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) id!: string;
  @Column({ type: 'char', length: 64 }) request_hash!: string;
  @Column({ type: 'json', nullable: true }) result_reference_json!:
    | string
    | null;
  @Column({ type: 'bigint' }) expires_at!: number;
}
