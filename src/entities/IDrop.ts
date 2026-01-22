import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  DROP_BOOSTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE
} from '../constants';

export enum DropType {
  CHAT = 'CHAT',
  PARTICIPATORY = 'PARTICIPATORY',
  WINNER = 'WINNER'
}

@Entity(DROPS_TABLE)
@Index('idx_drop_wave_author', ['wave_id', 'author_id'])
@Index('idx_drop_wave_type_author', ['wave_id', 'drop_type', 'author_id'])
@Index('idx_drop_wave_created_at', ['wave_id', 'created_at'])
export class DropEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly serial_no!: number;
  @Column({ type: 'varchar', length: 100, unique: true })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly wave_id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly author_id!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly updated_at!: number | null;
  @Column({ type: 'varchar', length: 250, nullable: true })
  readonly title!: string | null;
  @Column({ type: 'bigint' })
  readonly parts_count!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly reply_to_drop_id!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly reply_to_part_id!: number | null;
  @Column({
    type: 'varchar',
    length: 50,
    nullable: false,
    default: DropType.CHAT
  })
  readonly drop_type!: DropType;
  @Column({ type: 'text', nullable: true, default: null })
  readonly signature!: string | null;
  @Column({ type: 'boolean', default: false })
  readonly hide_link_preview?: boolean;
}

@Entity(DROPS_PARTS_TABLE)
export class DropPartEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @PrimaryColumn({ type: 'bigint' })
  readonly drop_part_id!: number;
  @Column({ type: 'text', nullable: true })
  @Index('idx_drop_part_content_fulltext', {
    fulltext: true
  })
  readonly content!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly quoted_drop_id!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly quoted_drop_part_id!: number | null;
  @Index('idx_drop_part_wave_id')
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

@Entity(DROPS_MENTIONS_TABLE)
export class DropMentionEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly drop_id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly mentioned_profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly handle_in_content!: string;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

@Entity(DROP_REFERENCED_NFTS_TABLE)
@Index('drop_referenced_token', ['contract', 'token'])
export class DropReferencedNftEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly drop_id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly contract!: string;
  @Column({ type: 'varchar', length: 250 })
  readonly token!: string;
  @Column({ type: 'varchar', length: 500 })
  readonly name!: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

@Entity(DROP_METADATA_TABLE)
export class DropMetadataEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly drop_id!: string;
  @Column({ type: 'varchar', length: 500 })
  readonly data_key!: string;
  @Column({ type: 'text' })
  readonly data_value!: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

@Entity(DROP_MEDIA_TABLE)
export class DropMediaEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly drop_part_id!: number;
  @Column({ type: 'varchar', length: 2000 })
  readonly url!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly mime_type!: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}

@Entity(DROP_BOOSTS_TABLE)
export class DropBoostEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly drop_id!: string;
  @Index()
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly booster_id!: string;
  @Column({ type: 'bigint', nullable: false })
  @Index()
  readonly boosted_at!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string | null;
}
