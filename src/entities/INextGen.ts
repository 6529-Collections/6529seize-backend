import { Entity, CreateDateColumn, PrimaryColumn, Column } from 'typeorm';
import {
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_COLLECTIONS_TABLE
} from '../constants';
import * as mysql from 'mysql';

@Entity(NEXTGEN_ALLOWLIST_TABLE)
export class NextGenAllowlist {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

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

@Entity(NEXTGEN_COLLECTIONS_TABLE)
export class NextGenCollection {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  merkle_root!: string;

  @Column({ type: 'json' })
  merkle_tree!: string;

  @Column({ type: 'int', default: -1 })
  collection_id!: number;

  @Column({ type: 'text', nullable: true })
  phase!: string;
}

export function extractNextGenAllowlistInsert(nextgen: NextGenAllowlist[]) {
  const values = nextgen.map((entry) => {
    return `(${mysql.escape(entry.merkle_root)}, ${mysql.escape(
      entry.address
    )}, ${entry.spots}, ${mysql.escape(entry.info)}, ${mysql.escape(
      entry.keccak
    )})`;
  });

  return `INSERT INTO ${NEXTGEN_ALLOWLIST_TABLE} (merkle_root, address, spots, info, keccak) VALUES ${values.join(
    ','
  )}`;
}

export function extractNextGenCollectionInsert(nextgen: NextGenCollection) {
  return `INSERT INTO ${NEXTGEN_COLLECTIONS_TABLE} (merkle_root, merkle_tree) VALUES (${mysql.escape(
    nextgen.merkle_root
  )}, ${mysql.escape(nextgen.merkle_tree)})`;
}
