import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_VOTER_STATE_TABLE } from '@/constants';

@Entity(DROP_VOTER_STATE_TABLE)
export class DropVoterStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly voter_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly votes!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
}
