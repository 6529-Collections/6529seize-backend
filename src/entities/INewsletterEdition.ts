import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  NEWSLETTER_EDITION_SOURCES_TABLE,
  NEWSLETTER_EDITIONS_TABLE
} from '@/constants';

export enum NewsletterEditionStatus {
  Rejected = 'REJECTED',
  Published = 'PUBLISHED'
}

/**
 * One newsletter edition attempt. A rejected row keeps the model's raw output,
 * the validator's reasons and the source registry snapshot for inspection; a
 * published row records the drop that carries the edition.
 */
@Entity(NEWSLETTER_EDITIONS_TABLE)
export class NewsletterEditionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly edition_id!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: NewsletterEditionStatus;

  @Column({ type: 'bigint', nullable: false })
  readonly window_start!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly window_end!: number;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly mode!: 'scheduled' | 'manual';

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Column({ type: 'longtext', nullable: false })
  readonly raw_output!: string;

  /** JSON array of validator reasons; null when published. */
  @Column({ type: 'text', nullable: true, default: null })
  readonly rejection_reasons!: string | null;

  /** JSON array of SourceRecord: the registry the output was validated against. */
  @Column({ type: 'longtext', nullable: false })
  readonly sources!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * One validated source record of a published edition, queryable for the public
 * history endpoint. Rows are re-joined to live drops at read time.
 */
@Entity(NEWSLETTER_EDITION_SOURCES_TABLE)
@Index('idx_newsletter_edition_sources_wave_time', [
  'wave_id',
  'time',
  'source_id'
])
@Index('idx_newsletter_edition_sources_time', ['time', 'source_id'])
export class NewsletterEditionSourceEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly edition_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly source_id!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly kind!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;

  @Column({ type: 'varchar', length: 250, nullable: true, default: null })
  readonly wave_name!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly time!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly collected_at!: number;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly canonical_url!: string;

  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly title!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly author_handle!: string | null;

  @Column({ type: 'char', length: 64, nullable: false })
  readonly content_fingerprint!: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly context_only!: boolean;
}
