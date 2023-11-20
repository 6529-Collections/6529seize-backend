import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { PROFILES_ARCHIVE_TABLE, PROFILES_TABLE } from '../constants';

class ProfileBase {
  @Column({ type: 'varchar', length: 100 })
  external_id!: string;

  @Column({ type: 'varchar', length: 100 })
  handle!: string;

  @Column({ type: 'varchar', length: 50 })
  primary_wallet!: string;

  @Column({ type: 'datetime' })
  created_at!: Date;

  @Column({ type: 'varchar', length: 50 })
  created_by_wallet!: string;

  @Column({ type: 'datetime', nullable: true, default: null })
  updated_at?: Date;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  updated_by_wallet?: string;

  @Column({ type: 'text', nullable: true, default: null })
  pfp_url?: string;

  @Column({ type: 'text', nullable: true, default: null })
  banner_1?: string;

  @Column({ type: 'text', nullable: true, default: null })
  banner_2?: string;

  @Column({ type: 'text', nullable: true, default: null })
  website?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  classification?: ProfileClassification | null;
}

@Entity(PROFILES_TABLE)
export class Profile extends ProfileBase {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  normalised_handle!: string;
}

@Entity(PROFILES_ARCHIVE_TABLE)
export class ProfileArchived extends ProfileBase {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  normalised_handle!: string;
}

export enum ProfileClassification {
  GOVERNMENT_NAME = 'GOVERNMENT_NAME',
  PSEUDONYM = 'PSEUDONYM',
  ORGANIZATION = 'ORGANIZATION',
  AI = 'AI',
  BOT = 'BOT',
  PARODY = 'PARODY'
}
