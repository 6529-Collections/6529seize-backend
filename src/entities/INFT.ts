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

export interface LabNFT extends BaseNFT {
  meme_references: number[];
}

export interface NFT extends BaseNFT {
  hodl_rate: number;
  market_cap: number;
  floor_price: number;
}

export interface NftTDH {
  id: number;
  tdh_rank: number;
  contract: string;
  tdh: number;
  tdh__raw: number;
}

export interface NFTWithTDH extends NFT, NftTDH {}

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
}
