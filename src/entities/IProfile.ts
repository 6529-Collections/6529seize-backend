import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { PROFILES_ARCHIVE_TABLE, PROFILES_TABLE } from '../constants';

export interface ProfileType {
  external_id: string;
  normalised_handle: string;
  handle: string;
  primary_wallet: string;
  created_at: Date;
  created_by_wallet: string;
  updated_at?: Date | null;
  updated_by_wallet?: string;
  pfp_url?: string;
  banner_1?: string;
  banner_2?: string;
  website?: string;
  classification?: ProfileClassification | null;
}

class ProfileBase implements Omit<ProfileType, 'normalised_handle'> {
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
  updated_at?: Date | null;

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

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  sub_classification?: string | null;
}

@Entity(PROFILES_TABLE)
export class Profile extends ProfileBase implements ProfileType {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  normalised_handle!: string;
}

@Entity(PROFILES_ARCHIVE_TABLE)
export class ProfileArchived extends ProfileBase implements ProfileType {
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
  PARODY = 'PARODY',
  COLLECTION = 'COLLECTION'
}
