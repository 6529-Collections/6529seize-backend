import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_TRAIN_ITEMS_TABLE } from '@/constants';

@Entity(RELEASE_TRAIN_ITEMS_TABLE)
@Index('uq_release_train_item', ['train_id', 'revision', 'candidate_id'], {
  unique: true
})
@Index('idx_release_train_item_candidate', ['candidate_id'])
export class ReleaseTrainItemEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'int' }) readonly revision!: number;
  @Column({ type: 'varchar', length: 36 }) readonly candidate_id!: string;
  @Column({ type: 'int' }) readonly sequence!: number;
  @Column({ type: 'varchar', length: 32, default: 'INCLUDED' })
  readonly status!: string;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly hold_reason!: string | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
}
