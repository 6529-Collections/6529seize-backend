import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { ENS_TABLE } from '@/constants';

@Entity(ENS_TABLE)
export class ENS {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'varchar', length: 150, nullable: true, default: null })
  display!: string | null;
}
