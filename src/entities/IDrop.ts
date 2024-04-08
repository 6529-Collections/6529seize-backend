import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  DROP_DISCUSSION_COMMENT_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_TABLE
} from '../constants';

@Entity(DROPS_TABLE)
@Index('storm_sequence', ['root_drop_id', 'storm_sequence'], { unique: true })
export class Drop {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly author_id!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'varchar', length: 250, nullable: true })
  readonly title!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly content!: string | null;
  @Column({ type: 'bigint', nullable: true })
  @Index()
  readonly root_drop_id!: number | null;
  @Column({ type: 'integer' })
  readonly storm_sequence!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly quoted_drop_id!: number | null;
  @Column({ type: 'varchar', length: 2000, nullable: true })
  readonly media_url!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly media_mime_type!: string | null;
}

@Entity(DROPS_MENTIONS_TABLE)
export class DropMentionEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'bigint' })
  @Index()
  readonly drop_id!: number;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly mentioned_profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly handle_in_content!: string;
}

@Entity(DROP_REFERENCED_NFTS_TABLE)
@Index('drop_referenced_token', ['contract', 'token'])
export class DropReferencedNftEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'bigint' })
  @Index()
  readonly drop_id!: number;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly contract!: string;
  @Column({ type: 'varchar', length: 250 })
  readonly token!: string;
  @Column({ type: 'varchar', length: 500 })
  readonly name!: string;
}

@Entity(DROP_METADATA_TABLE)
export class DropMetadataEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'bigint' })
  @Index()
  readonly drop_id!: number;
  @Column({ type: 'varchar', length: 500 })
  readonly data_key!: string;
  @Column({ type: 'varchar', length: 500 })
  readonly data_value!: string;
}

@Entity(DROP_DISCUSSION_COMMENT_TABLE)
export class DropDiscussionCommentEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'bigint' })
  @Index()
  readonly drop_id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly author_id!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'text' })
  readonly content!: string;
}
