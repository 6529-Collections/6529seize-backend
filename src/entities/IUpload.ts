import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { CONSOLIDATED_UPLOADS_TABLE, UPLOADS_TABLE } from '../constants';

export class Upload {
  @PrimaryColumn({ type: 'varchar', length: 8 })
  date!: Date;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'text' })
  tdh!: string;

  @Index()
  @Column({ type: 'bigint', default: 0, nullable: false })
  timestamp!: number;
}

@Entity({ name: CONSOLIDATED_UPLOADS_TABLE })
export class ConsolidatedTDHUpload extends Upload {}

@Entity({ name: UPLOADS_TABLE })
export class UploadEntity extends Upload {}

@Entity({ name: CONSOLIDATED_UPLOADS_TABLE })
export class UploadE extends Upload {}

export interface UploadFields {
  block: number;
  date: string;
  total_balance: number;
  boosted_tdh: number;
  tdh_rank: number;
  tdh: number;
  tdh__raw: number;
  boost: number;
  memes_balance: number;
  unique_memes: number;
  memes_cards_sets: number;
  memes_cards_sets_minus1: number;
  memes_cards_sets_minus2: number;
  genesis: number;
  nakamoto: number;
  boosted_memes_tdh: number;
  memes_tdh: number;
  memes_tdh__raw: number;
  tdh_rank_memes: number;
  memes: string;
  gradients_balance: number;
  boosted_gradients_tdh: number;
  gradients_tdh: number;
  gradients_tdh__raw: number;
  tdh_rank_gradients: number;
  gradients: string;
  nextgen_balance: number;
  boosted_nextgen_tdh: number;
  nextgen_tdh: number;
  nextgen_tdh__raw: number;
  nextgen: string;
  boost_breakdown: string;
}

export interface UploadFieldsConsolidation extends UploadFields {
  consolidation_display: string;
  consolidation_key: string;
  wallets: string[];
}

export interface UploadFieldsWallet extends UploadFields {
  wallet: string;
  ens: string;
}
