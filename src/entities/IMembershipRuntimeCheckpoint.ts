import { Column, Entity, PrimaryColumn } from 'typeorm';
import { MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE } from '@/constants';

/** Independent, strictly decoded GC and dispatcher progress; never source authority. */
@Entity(MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE)
export class MembershipRuntimeCheckpointEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 64,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly id!: string;

  @Column({ type: 'int', nullable: false })
  readonly protocol_version!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly revision!: string;

  @Column({ type: 'json', nullable: false })
  readonly progress!: unknown;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at_millis!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
