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
  const values = nextgen.map((entry) => {
    return `(${mysql.escape(entry.merkle_root)}, ${mysql.escape(
      collectionId
    )}, ${mysql.escape(entry.address)}, ${entry.spots}, ${mysql.escape(
      entry.info
    )}, ${mysql.escape(entry.keccak)})`;
  });

  return `INSERT INTO ${NEXTGEN_ALLOWLIST_TABLE} (merkle_root, collection_id, address, spots, info, keccak) VALUES ${values.join(
    ','
  )}`;
}

export function extractNextGenAllowlistBurnInsert(
  collectionId: number,
  nextgen: NextGenAllowlistBurn[]
) {
  const values = nextgen.map((entry) => {
    return `(${mysql.escape(entry.merkle_root)}, ${mysql.escape(
      collectionId
    )}, ${entry.token_id}, ${mysql.escape(entry.info)}, ${mysql.escape(
      entry.keccak
    )})`;
  });

  return `INSERT INTO ${NEXTGEN_ALLOWLIST_BURN_TABLE} (merkle_root, collection_id, token_id, info, keccak) VALUES ${values.join(
    ','
  )}`;
}

export function extractNextGenCollectionInsert(nextgen: NextGenCollection) {
  return `INSERT INTO ${NEXTGEN_COLLECTIONS_TABLE} (merkle_root, collection_id, added_by, al_type, merkle_tree, phase) VALUES (${mysql.escape(
    nextgen.merkle_root
  )}, ${mysql.escape(nextgen.collection_id)}, ${mysql.escape(
    nextgen.added_by
  )}, ${mysql.escape(nextgen.al_type)}, ${mysql.escape(
    nextgen.merkle_tree
  )}, ${mysql.escape(nextgen.phase)})`;
}

export function extractNextGenCollectionBurnInsert(
  collectionBurn: NextGenCollectionBurn
) {
  return `INSERT INTO nextgen_burn_collection (
  collection_id, 
  burn_collection, 
  burn_collection_id, 
  min_token_index, 
  max_token_index, 
  burn_address, 
  status
) VALUES (
  ${collectionBurn.collection_id}, ${mysql.escape(
    collectionBurn.burn_collection
  )}, ${collectionBurn.burn_collection_id}, ${
    collectionBurn.min_token_index
  }, ${collectionBurn.max_token_index}, ${mysql.escape(
    collectionBurn.burn_address
  )}, ${collectionBurn.status}
) ON DUPLICATE KEY UPDATE
  burn_collection = VALUES(burn_collection),
  burn_collection_id = VALUES(burn_collection_id),
  min_token_index = VALUES(min_token_index),
  max_token_index = VALUES(max_token_index),
  burn_address = VALUES(burn_address),
  status = VALUES(status);`;
}
