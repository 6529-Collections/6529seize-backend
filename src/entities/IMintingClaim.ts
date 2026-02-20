import { MINTING_CLAIMS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export interface MintingClaimAttribute {
  trait_type: string;
  value: string | number;
  display_type?: string;
  max_value?: number;
}

export interface MintingClaimImageDetails {
  bytes: number;
  format: string;
  sha256: string;
  width: number;
  height: number;
}

export interface MintingClaimAnimationDetailsVideo {
  bytes: number;
  format: string;
  duration: number;
  sha256: string;
  width: number;
  height: number;
  codecs: string[];
}

export interface MintingClaimAnimationDetailsHtml {
  format: 'HTML';
}

export interface MintingClaimAnimationDetailsGlb {
  bytes: number;
  format: 'GLB';
  sha256: string;
}

export type MintingClaimAnimationDetails =
  | MintingClaimAnimationDetailsVideo
  | MintingClaimAnimationDetailsHtml
  | MintingClaimAnimationDetailsGlb;

@Entity(MINTING_CLAIMS_TABLE)
@Index('minting_claims_contract_claim_id_uq', ['contract', 'claim_id'], {
  unique: true
})
export class MintingClaimEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @Column({ type: 'int' })
  readonly claim_id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly image_location!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly animation_location!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  readonly metadata_location!: string | null;

  @Column({ type: 'boolean', default: false })
  readonly media_uploading!: boolean;

  @Column({ type: 'int', nullable: true })
  readonly edition_size!: number | null;

  @Column({ type: 'text' })
  readonly description!: string;

  @Column({ type: 'varchar', length: 255 })
  readonly name!: string;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  readonly image_url!: string | null;

  @Column({ type: 'json' })
  readonly attributes!: MintingClaimAttribute[];

  @Column({ type: 'json', nullable: true })
  readonly image_details!: MintingClaimImageDetails | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  readonly animation_url!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly animation_details!: MintingClaimAnimationDetails | null;
}
