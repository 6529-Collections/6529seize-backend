import { Entity, Column, PrimaryColumn } from 'typeorm';
import { MEMES_EXTENDED_DATA_TABLE } from '@/constants';

export class BaseNFT {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'timestamp' })
  created_at!: Date;

  @Column({ type: 'timestamp', nullable: true })
  mint_date?: Date;

  @Column({ type: 'double' })
  mint_price!: number;

  @Column({ type: 'int' })
  supply!: number;

  @Column({ nullable: true, type: 'text' })
  name?: string;

  @Column({ type: 'text' })
  collection!: string;

  @Column({ type: 'text' })
  token_type!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text' })
  artist!: string;

  @Column({ type: 'text' })
  artist_seize_handle!: string;

  @Column({ nullable: true, type: 'text' })
  uri?: string;

  @Column({ nullable: true, type: 'text' })
  icon?: string;

  @Column({ nullable: true, type: 'text' })
  thumbnail?: string;

  @Column({ nullable: true, type: 'text' })
  scaled?: string;

  @Column({ nullable: true, type: 'text' })
  image?: string;

  @Column({ nullable: true, type: 'text' })
  compressed_animation?: string;

  @Column({ nullable: true, type: 'text' })
  animation?: string;

  @Column({ type: 'json', nullable: true })
  metadata?: any;

  @Column({ type: 'double' })
  floor_price!: number;

  @Column({ type: 'text', nullable: true })
  floor_price_from!: string | null;

  @Column({ type: 'double' })
  market_cap!: number;

  @Column({ type: 'double' })
  total_volume_last_24_hours!: number;

  @Column({ type: 'double' })
  total_volume_last_7_days!: number;

  @Column({ type: 'double' })
  total_volume_last_1_month!: number;

  @Column({ type: 'double' })
  total_volume!: number;

  @Column({ type: 'double' })
  highest_offer!: number;

  @Column({ type: 'text', nullable: true })
  highest_offer_from!: string | null;
}

@Entity('nfts_meme_lab')
export class LabNFT extends BaseNFT {
  @Column({ type: 'json' })
  meme_references!: number[];
}

@Entity('nfts')
export class NFT extends BaseNFT {
  @Column({ type: 'double' })
  hodl_rate!: number;

  @Column({ type: 'int' })
  boosted_tdh!: number;

  @Column({ type: 'int' })
  tdh!: number;

  @Column({ type: 'int' })
  tdh__raw!: number;

  @Column({ type: 'int' })
  tdh_rank!: number;
}

export class ExtendedDataBase {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'datetime' })
  created_at!: Date;

  @Column({ type: 'int' })
  collection_size!: number;

  @Column({ type: 'int' })
  edition_size!: number;

  @Column({ type: 'int' })
  edition_size_rank!: number;

  @Column({ type: 'int' })
  museum_holdings!: number;

  @Column({ type: 'int' })
  museum_holdings_rank!: number;

  @Column({ type: 'int' })
  edition_size_cleaned!: number;

  @Column({ type: 'int' })
  edition_size_cleaned_rank!: number;

  @Column({ type: 'int' })
  hodlers!: number;

  @Column({ type: 'int' })
  hodlers_rank!: number;

  @Column({ type: 'double' })
  percent_unique!: number;

  @Column({ type: 'int' })
  percent_unique_rank!: number;

  @Column({ type: 'double' })
  percent_unique_cleaned!: number;

  @Column({ type: 'int' })
  percent_unique_cleaned_rank!: number;

  @Column({ type: 'int' })
  burnt!: number;

  @Column({ type: 'int' })
  edition_size_not_burnt!: number;

  @Column({ type: 'int' })
  edition_size_not_burnt_rank!: number;

  @Column({ type: 'double' })
  percent_unique_not_burnt!: number;

  @Column({ type: 'int' })
  percent_unique_not_burnt_rank!: number;
}

@Entity(MEMES_EXTENDED_DATA_TABLE)
export class MemesExtendedData extends ExtendedDataBase {
  @Column({ type: 'int' })
  season!: number;

  @Column({ type: 'int' })
  meme!: number;

  @Column({ type: 'text' })
  meme_name!: string;
}

export interface NFTWithExtendedData extends NFT, MemesExtendedData {}

@Entity()
export class LabExtendedData extends ExtendedDataBase {
  @Column({ type: 'json' })
  meme_references!: number[];

  @Column({ type: 'text' })
  metadata_collection!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ nullable: true, type: 'text' })
  website?: string;
}
