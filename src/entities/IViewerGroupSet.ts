import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  VIEWER_GROUP_SET_MEMBERS_TABLE,
  VIEWER_GROUP_SETS_TABLE
} from '@/constants/db-tables';

/**
 * A viewer's eligible group set, stored once and addressed by the SHA-256 of
 * its sorted ids (see waves/viewer-group-sets.ts). Sets are immutable: a
 * different membership is a different hash. No viewer identifier is stored.
 * The header is written last, in the members' transaction, so its presence
 * means the set is complete.
 */
@Entity(VIEWER_GROUP_SETS_TABLE)
@Index('idx_viewer_group_sets_last_used_at', ['last_used_at'])
export class ViewerGroupSetEntity {
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly set_hash!: string;

  @Column({ type: 'int' })
  readonly group_count!: number;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  /** Touched at most daily while in use; unused sets are cleaned up. */
  @Column({ type: 'bigint' })
  readonly last_used_at!: number;
}

@Entity(VIEWER_GROUP_SET_MEMBERS_TABLE)
export class ViewerGroupSetMemberEntity {
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly set_hash!: string;

  /** Same type and collation as waves.visibility_group_id. */
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly group_id!: string;
}
