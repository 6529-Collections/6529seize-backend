import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PERSONAL_RECORDS_STATE_TABLE } from '@/constants';

/**
 * The personal settings switch, shared by the API and the loop that runs
 * the import: whether settings writes are frozen, and the order key of the
 * latest import (its finalized height and time). One row, id `switch`.
 */
@Entity(PERSONAL_RECORDS_STATE_TABLE)
export class PersonalRecordsStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 16, nullable: false })
  readonly id!: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly frozen!: boolean;

  @Column({ type: 'bigint', unsigned: true, nullable: true, default: null })
  readonly import_anchor!: number | null;

  @Column({ type: 'bigint', unsigned: true, nullable: true, default: null })
  readonly import_at!: number | null;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly updated_at!: number;
}
