import { MEMES_CLAIMS_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

export interface MemeClaimAttribute {
  trait_type: string;
  value: string | number;
  display_type?: string;
  max_value?: number;
}

export interface MemeClaimImageDetails {
  bytes: number;
  format: string;
  sha256: string;
  width: number;
  height: number;
}

export interface MemeClaimAnimationDetailsVideo {
  bytes: number;
  format: string;
  duration: number;
  sha256: string;
  width: number;
  height: number;
  codecs: string[];
}

export interface MemeClaimAnimationDetailsHtml {
  format: 'HTML';
}

export interface MemeClaimAnimationDetailsGlb {
  bytes: number;
  format: 'GLB';
  sha256: string;
}

export type MemeClaimAnimationDetails =
  | MemeClaimAnimationDetailsVideo
  | MemeClaimAnimationDetailsHtml
  | MemeClaimAnimationDetailsGlb;

@Entity(MEMES_CLAIMS_TABLE)
export class MemeClaimEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'int', unique: true })
  readonly meme_id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly image_location!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly animation_location!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  readonly metadata_location!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly arweave_synced_at!: number | null;

  @Column({ type: 'int', nullable: true })
  readonly edition_size!: number | null;

  @Column({ type: 'text' })
  readonly description!: string;

  @Column({ type: 'varchar', length: 255 })
  readonly name!: string;

  @Column({ type: 'varchar', length: 1024, nullable: true, name: 'image' })
  readonly image_url!: string | null;

  @Column({ type: 'json' })
  readonly attributes!: MemeClaimAttribute[];

  @Column({ type: 'json', nullable: true })
  readonly image_details!: MemeClaimImageDetails | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  readonly animation_url!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly animation_details!: MemeClaimAnimationDetails | null;
}
