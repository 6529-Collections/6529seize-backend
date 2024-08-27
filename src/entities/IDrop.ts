import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE
} from '../constants';

@Entity(DROPS_TABLE)
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
}

@Entity(DROPS_PARTS_TABLE)
export class DropPartEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @PrimaryColumn({ type: 'bigint' })
  readonly drop_part_id!: number;
  @Column({ type: 'text', nullable: true })
  readonly content!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly quoted_drop_id!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly quoted_drop_part_id!: number | null;
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
  @Column({ type: 'varchar', length: 500 })
  readonly data_value!: string;
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
}
