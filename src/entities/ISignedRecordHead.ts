import { Column, Entity, PrimaryColumn } from 'typeorm';
import { SIGNED_RECORD_HEADS_TABLE } from '@/constants';

/**
 * The newest change indexed per (owner, family, type, key) of signed
 * records, by the merge order (anchor, claimed time, event id). An index:
 * a rebuild fills it again from the records. The key columns compare bytes
 * (utf8mb4_bin), so keys differing only in case or accents stay apart.
 * A row with anchor 0 is a placeholder taken for its lock.
 */
@Entity(SIGNED_RECORD_HEADS_TABLE)
export class SignedRecordHeadEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 128,
    nullable: false,
    collation: 'utf8mb4_bin'
  })
  readonly owner!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 8,
    nullable: false,
    collation: 'utf8mb4_bin'
  })
  readonly family!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 32,
    nullable: false,
    collation: 'utf8mb4_bin'
  })
  readonly rtype!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8mb4_bin'
  })
  readonly rkey!: string;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly anchor!: number;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly claimed_time!: number;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly event_id!: string;
}
