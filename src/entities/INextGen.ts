import { Entity, CreateDateColumn, PrimaryColumn, Column } from 'typeorm';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_TRANSACTIONS_BLOCK_TABLE
} from '../constants';
import * as mysql from 'mysql';

@Entity(NEXTGEN_TRANSACTIONS_BLOCK_TABLE)
export class NextGenTransactionsBlock {
  @PrimaryColumn({ type: 'int' })
  block_number!: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;
}

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

  @Column({ type: 'text' })
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

  @PrimaryColumn({ type: 'int' })
  token_id!: string;

  @Column({ type: 'text' })
  info!: string;

  @Column({ type: 'text' })
  keccak!: string;
}

@Entity(NEXTGEN_COLLECTIONS_TABLE)
export class NextGenCollection {
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

  @Column({ type: 'text', nullable: true })
  al_type!: string;

  @Column({ type: 'text', nullable: true })
  phase!: string;
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

  @Column({ type: 'int' })
  min_token_index!: number;

  @Column({ type: 'int' })
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
    params[addressKey] = entry.address;
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

export function extractNextGenCollectionInsert(nextgen: NextGenCollection) {
  const params = {
    merkleRoot: nextgen.merkle_root,
    collectionId: nextgen.collection_id,
    addedBy: nextgen.added_by,
    alType: nextgen.al_type,
    merkleTree: nextgen.merkle_tree,
    phase: nextgen.phase
  };

  const sql = `INSERT INTO ${NEXTGEN_COLLECTIONS_TABLE} (merkle_root, collection_id, added_by, al_type, merkle_tree, phase) VALUES (:merkleRoot, :collectionId, :addedBy, :alType, :merkleTree, :phase)`;

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
    INSERT INTO nextgen_burn_collection (
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
