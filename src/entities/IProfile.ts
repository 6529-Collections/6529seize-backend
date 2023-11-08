import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILES_TABLE } from '../constants';

@Entity(PROFILES_TABLE)
export class Profile {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  normalised_handle!: string;

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

export enum ProfileClassification {
  GOVERNMENT_NAME = 'GOVERNMENT_NAME',
  PSEUDONYM = 'PSEUDONYM',
  ORGANIZATION = 'ORGANIZATION',
  AI = 'AI',
  BOT = 'BOT',
  PARODY = 'PARODY'
}
