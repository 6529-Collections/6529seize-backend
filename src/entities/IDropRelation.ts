import { Column, Index, PrimaryGeneratedColumn } from 'typeorm';

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
  readonly timestamp!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}
