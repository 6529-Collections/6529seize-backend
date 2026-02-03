import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DELETED_DROPS_TABLE } from '@/constants';

@Entity(DELETED_DROPS_TABLE)
export class DeletedDropEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly wave_id!: string;
  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly author_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly deleted_at!: number;
}
