import { Entity, Column, PrimaryColumn, BaseEntity } from 'typeorm';
export interface BaseNFT {
  id: number;
  contract: string;
  created_at: Date;
  mint_date: Date;
  mint_price: number;
  supply: number;
  name?: string;
  collection: string;
  token_type: string;
  description: string;
  artist: string;
  uri?: string;
  icon?: string;
  thumbnail?: string;
  scaled?: string;
  image?: string;
  compressed_animation?: string;
  animation?: string;
  metadata?: any;
}

@Entity('nfts_meme_lab')
export class LabNFT {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'timestamp' })
  created_at!: Date;

  @Column({ type: 'timestamp' })
  mint_date!: Date;

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

  @Column({ type: 'json' })
  meme_references!: number[];

  @Column({ type: 'double' })
  floor_price!: number;

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
}

@Entity('nfts')
export class NFT {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'timestamp' })
  created_at!: Date;

  @Column({ type: 'timestamp' })
  mint_date!: Date;

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

  @Column({ type: 'double' })
  hodl_rate!: number;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text' })
  artist!: string;

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

  @Column({ type: 'int' })
  tdh!: number;

  @Column({ type: 'int' })
  tdh__raw!: number;

  @Column({ type: 'int' })
  tdh_rank!: number;

  @Column({ type: 'double' })
  floor_price!: number;

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
}

export interface MemesExtendedData {
  id: number;
  created_at: Date;
  season: number;
  meme: number;
  meme_name: string;
  collection_size: number;
  edition_size: number;
  edition_size_rank: number;
  museum_holdings: number;
  museum_holdings_rank: number;
  edition_size_cleaned: number;
  edition_size_cleaned_rank: number;
  hodlers: number;
  hodlers_rank: number;
  percent_unique: number;
  percent_unique_rank: number;
  percent_unique_cleaned: number;
  percent_unique_cleaned_rank: number;
}

export interface NFTWithExtendedData extends NFT, MemesExtendedData {}

@Entity()
export class LabExtendedData {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'datetime' })
  created_at!: Date;

  @Column({ type: 'json' })
  meme_references!: number[];

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  metadata_collection!: string;

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

  @Column({ nullable: true, type: 'text' })
  website?: string;
}
