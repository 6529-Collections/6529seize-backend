import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_RELATIONS_TABLE } from '@/constants';

@Entity(DROP_RELATIONS_TABLE)
export class DropRelationEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly parent_id!: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly child_id!: string;
  @Index()
  @Column({ type: 'bigint', nullable: false })
  readonly child_serial_no!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}
