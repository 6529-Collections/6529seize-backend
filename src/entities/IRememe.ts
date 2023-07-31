import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import { REMEMES_TABLE, REMEMES_UPLOADS } from '../constants';

@Entity(REMEMES_TABLE)
export class Rememe {
  @CreateDateColumn()
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'text' })
  deployer?: string;

  @Column({ type: 'text' })
  token_uri!: string;

  @Column({ type: 'text' })
  token_type!: string;

  @Column({ type: 'text' })
  image?: string;

  @Column({ type: 'text' })
  animation?: string;

  @Column({ type: 'json' })
  meme_references!: number[];

  @Column({ type: 'json', nullable: true })
  metadata?: any;

  @Column({ type: 'json' })
  contract_opensea_data!: any;

  @Column({ type: 'json' })
  media!: any;

  @Column({ type: 'text', nullable: true, default: null })
  s3_image_original!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  s3_image_scaled!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  s3_image_thumbnail!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  s3_image_icon!: string | null;
}

@Entity(REMEMES_UPLOADS)
export class RememeUpload {
  @CreateDateColumn()
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 150 })
  url!: string;
}
