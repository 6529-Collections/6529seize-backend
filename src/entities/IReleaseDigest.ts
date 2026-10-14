import {
  RELEASE_DIGEST_ENTRIES_TABLE,
  RELEASE_DIGESTS_TABLE
} from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ReleaseDigestStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED'
}

/**
 * One merged pull request that reached production, recorded when its
 * per-deploy release note is generated. The daily release digest claims
 * unassigned entries and summarizes them for the public Releases wave.
 */
@Entity(RELEASE_DIGEST_ENTRIES_TABLE)
@Index('idx_release_digest_entries_digest_deployed', [
  'digest_id',
  'deployed_at'
])
export class ReleaseDigestEntryEntity {
  @PrimaryColumn({ type: 'char', length: 64, nullable: false })
  readonly id!: string;

  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly repository!: string;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly pull_request_number!: number;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly pull_request_title!: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly pull_request_url!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly pull_request_body!: string | null;

  @Column({ type: 'text', nullable: false })
  readonly summary!: string;

  /** JSON array of ReleaseDigestContributor. */
  @Column({ type: 'text', nullable: false })
  readonly contributors!: string;

  /** JSON array of deployable service names (empty for frontend). */
  @Column({ type: 'text', nullable: false })
  readonly services!: string;

  @Column({ type: 'char', length: 64, nullable: false })
  readonly publication_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly deployed_at!: number;

  @Column({ type: 'char', length: 36, nullable: true, default: null })
  readonly digest_id!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/** A daily digest post and the entries it claimed. */
@Entity(RELEASE_DIGESTS_TABLE)
@Index('uq_release_digests_digest_key', ['digest_key'], { unique: true })
export class ReleaseDigestEntity {
  @PrimaryColumn({ type: 'char', length: 36, nullable: false })
  readonly id!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly digest_key!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: ReleaseDigestStatus;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly entry_count!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly published_at!: number | null;
}
