import {
  Entity,
  CreateDateColumn,
  PrimaryColumn,
  Column,
  UpdateDateColumn
} from 'typeorm';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_BLOCKS_TABLE,
  NEXTGEN_LOGS_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE,
  NEXTGEN_TOKEN_SCORES_TABLE,
  NEXTGEN_TOKENS_TDH_TABLE
} from '../nextgen/nextgen_constants';
import { BlockEntity } from './IBlock';

@Entity(NEXTGEN_ALLOWLIST_TABLE)
export class NextGenAllowlist {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'int' })
  collection_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  merkle_root!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  address!: string;

  @Column({ type: 'int' })
  spots!: number;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  info!: string;

  @Column({ type: 'text' })
  keccak!: string;
}

@Entity(NEXTGEN_ALLOWLIST_BURN_TABLE)
export class NextGenAllowlistBurn {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'int' })
  collection_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  merkle_root!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  token_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  info!: string;

  @Column({ type: 'text' })
  keccak!: string;
}

@Entity(NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE)
export class NextGenAllowlistCollection {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  merkle_root!: string;

  @PrimaryColumn({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'varchar', length: 50 })
  added_by!: string;

  @Column({ type: 'json' })
  merkle_tree!: string;

  @Column({ type: 'text' })
  al_type!: string;

  @Column({ type: 'text' })
  phase!: string;

  @Column({ type: 'bigint' })
  start_time!: number;

  @Column({ type: 'bigint' })
  end_time!: number;

  @Column({ type: 'double' })
  mint_price!: number;
}

@Entity(NEXTGEN_BURN_COLLECTIONS_TABLE)
export class NextGenCollectionBurn {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'varchar', length: 100 })
  burn_collection!: string;

  @Column({ type: 'int' })
  burn_collection_id!: number;

  @Column({ type: 'bigint' })
  min_token_index!: number;

  @Column({ type: 'bigint' })
  max_token_index!: number;

  @Column({ type: 'varchar', length: 100 })
  burn_address!: string;

  @Column({ type: 'boolean' })
  status!: boolean;
}

export function extractNextGenAllowlistInsert(
  collectionId: number,
  nextgen: NextGenAllowlist[]
) {
  const params: any = {};
  const values = nextgen.map((entry, index) => {
    const merkleRootKey = `merkleRoot${index}`;
    const addressKey = `address${index}`;
    const spotsKey = `spots${index}`;
    const infoKey = `info${index}`;
    const keccakKey = `keccak${index}`;

    params[merkleRootKey] = entry.merkle_root;
    params[addressKey] = entry.address.toLowerCase();
    params[spotsKey] = entry.spots;
    params[infoKey] = entry.info;
    params[keccakKey] = entry.keccak;

    return `(:${merkleRootKey}, ${collectionId}, :${addressKey}, :${spotsKey}, :${infoKey}, :${keccakKey})`;
  });

  const sql = `INSERT INTO ${NEXTGEN_ALLOWLIST_TABLE} (merkle_root, collection_id, address, spots, info, keccak) VALUES ${values.join(
    ','
  )}`;

  return {
    sql,
    params
  };
}

export function extractNextGenAllowlistBurnInsert(
  collectionId: number,
  nextgen: NextGenAllowlistBurn[]
) {
  const params: any = {};
  const values = nextgen.map((entry, index) => {
    // Create named parameters
    const merkleRootKey = `merkleRoot${index}`;
    const tokenIdKey = `tokenId${index}`;
    const infoKey = `info${index}`;
    const keccakKey = `keccak${index}`;

    // Assign values to named parameters
    params[merkleRootKey] = entry.merkle_root;
    params[tokenIdKey] = entry.token_id;
    params[infoKey] = entry.info;
    params[keccakKey] = entry.keccak;

    // Use named placeholders in the SQL string
    return `(:${merkleRootKey}, ${collectionId}, :${tokenIdKey}, :${infoKey}, :${keccakKey})`;
  });

  const sql = `INSERT INTO ${NEXTGEN_ALLOWLIST_BURN_TABLE} (merkle_root, collection_id, token_id, info, keccak) VALUES ${values.join(
    ','
  )}`;

  return {
    sql,
    params
  };
}

export function extractNextGenCollectionInsert(
  nextgen: NextGenAllowlistCollection
) {
  const params = {
    merkleRoot: nextgen.merkle_root,
    collectionId: nextgen.collection_id,
    addedBy: nextgen.added_by,
    alType: nextgen.al_type,
    merkleTree: nextgen.merkle_tree,
    phase: nextgen.phase,
    startTime: nextgen.start_time,
    endTime: nextgen.end_time,
    mintPrice: nextgen.mint_price
  };

  const sql = `INSERT INTO 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} (
      merkle_root, 
      collection_id, 
      added_by, 
      al_type, 
      merkle_tree, 
      phase,
      start_time,
      end_time,
      mint_price
    ) VALUES (
      :merkleRoot, 
      :collectionId, 
      :addedBy, 
      :alType, 
      :merkleTree, 
      :phase,
      :startTime,
      :endTime,
      :mintPrice
    )`;

  return {
    sql,
    params
  };
}

export function extractNextGenCollectionBurnInsert(
  collectionBurn: NextGenCollectionBurn
) {
  // Create named parameters
  const params = {
    collectionId: collectionBurn.collection_id,
    burnCollection: collectionBurn.burn_collection,
    burnCollectionId: collectionBurn.burn_collection_id,
    minTokenIndex: collectionBurn.min_token_index,
    maxTokenIndex: collectionBurn.max_token_index,
    burnAddress: collectionBurn.burn_address,
    status: collectionBurn.status
  };

  // Construct the SQL query using named placeholders
  const sql = `
    INSERT INTO ${NEXTGEN_BURN_COLLECTIONS_TABLE} (
      collection_id, 
      burn_collection, 
      burn_collection_id, 
      min_token_index, 
      max_token_index, 
      burn_address, 
      status
    ) VALUES (
      :collectionId, 
      :burnCollection, 
      :burnCollectionId, 
      :minTokenIndex, 
      :maxTokenIndex, 
      :burnAddress, 
      :status
    ) ON DUPLICATE KEY UPDATE
      burn_collection = VALUES(burn_collection),
      burn_collection_id = VALUES(burn_collection_id),
      min_token_index = VALUES(min_token_index),
      max_token_index = VALUES(max_token_index),
      burn_address = VALUES(burn_address),
      status = VALUES(status);
  `;

  return {
    sql,
    params
  };
}

@Entity(NEXTGEN_BLOCKS_TABLE)
export class NextGenBlock extends BlockEntity {}

@Entity(NEXTGEN_LOGS_TABLE)
export class NextGenLog {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  transaction!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'bigint' })
  block_timestamp!: number;

  @Column({ type: 'text' })
  log!: string;

  @Column({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'bigint', nullable: true })
  token_id?: number;

  @Column({ type: 'text' })
  source!: string;
}

@Entity(NEXTGEN_COLLECTIONS_TABLE)
export class NextGenCollection {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'int' })
  id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  artist!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text' })
  website!: string;

  @Column({ type: 'text' })
  licence!: string;

  @Column({ type: 'text' })
  base_uri!: string;

  @Column({ type: 'text' })
  library!: string;

  @Column({ type: 'text' })
  dependency_script!: string;

  @Column({ type: 'text' })
  image!: string;

  @Column({ type: 'text' })
  banner!: string;

  @Column({ type: 'text' })
  distribution_plan!: string;

  @Column({ type: 'text', nullable: true })
  artist_address?: string;

  @Column({ type: 'text', nullable: true })
  artist_signature?: string;

  @Column({ type: 'int', default: -1 })
  max_purchases?: number;

  @Column({ type: 'int', default: -1 })
  total_supply?: number;

  @Column({ type: 'int', default: -1 })
  final_supply_after_mint?: number;

  @Column({ type: 'int', default: 0 })
  mint_count!: number;

  @Column({ type: 'boolean', default: false })
  on_chain?: boolean;

  @Column({ type: 'bigint', default: -1 })
  allowlist_start?: number;

  @Column({ type: 'bigint', default: -1 })
  allowlist_end?: number;

  @Column({ type: 'bigint', default: -1 })
  public_start?: number;

  @Column({ type: 'bigint', default: -1 })
  public_end?: number;

  @Column({ type: 'text', nullable: true })
  merkle_root?: string;
}

@Entity(NEXTGEN_TOKENS_TABLE)
export class NextGenToken {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'int' })
  normalised_id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'text' })
  collection_name!: string;

  @Column({ type: 'datetime' })
  mint_date!: Date;

  @Column({ type: 'double' })
  mint_price!: number;

  @Column({ type: 'text' })
  metadata_url!: string;

  @Column({ type: 'text' })
  image_url!: string;

  @Column({ type: 'text', nullable: true })
  animation_url!: string;

  @Column({ type: 'json', nullable: true })
  generator!: string;

  @Column({ type: 'text' })
  owner!: string;

  @Column({ type: 'boolean' })
  pending!: boolean;

  @Column({ type: 'boolean' })
  burnt!: boolean;

  @Column({ type: 'datetime', nullable: true })
  burnt_date!: Date | undefined;

  @Column({ type: 'double' })
  hodl_rate!: number;
}

@Entity(NEXTGEN_TOKENS_TDH_TABLE)
export class NextGenTokenTDH {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'int' })
  normalised_id!: number;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'int', nullable: false })
  tdh!: number;

  @Column({ type: 'int', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;
}

@Entity(NEXTGEN_TOKEN_TRAITS_TABLE)
export class NextGenTokenTrait {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'int' })
  collection_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  trait!: string;

  @Column({ type: 'varchar', length: 100 })
  value!: string;

  @Column({ type: 'double' })
  statistical_rarity!: number;

  @Column({ type: 'double' })
  statistical_rarity_rank!: number;

  @Column({ type: 'double' })
  rarity_score!: number;

  @Column({ type: 'int' })
  rarity_score_rank!: number;

  @Column({ type: 'double' })
  rarity_score_normalised!: number;

  @Column({ type: 'int' })
  rarity_score_normalised_rank!: number;

  @Column({ type: 'int' })
  token_count!: number;

  @Column({ type: 'int', default: 0 })
  trait_count?: number;

  @Column({ type: 'int', default: 0 })
  value_count?: number;
}

@Entity(NEXTGEN_TOKEN_SCORES_TABLE)
export class NextGenTokenScore {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'int' })
  collection_id!: number;

  @Column({ type: 'double' })
  rarity_score!: number;

  @Column({ type: 'double' })
  rarity_score_normalised!: number;

  @Column({ type: 'double' })
  statistical_score!: number;

  @Column({ type: 'double' })
  single_trait_rarity_score!: number;

  @Column({ type: 'int' })
  rarity_score_rank?: number;

  @Column({ type: 'int' })
  rarity_score_normalised_rank?: number;

  @Column({ type: 'int' })
  statistical_score_rank?: number;

  @Column({ type: 'int' })
  single_trait_rarity_score_rank?: number;
}
