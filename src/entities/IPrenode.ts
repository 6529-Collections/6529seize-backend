import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { PRENODES_TABLE } from '@/constants';
import { Time } from '../time';

@Entity(PRENODES_TABLE)
export class Prenode {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  ip!: string;

  @Column({ type: 'text', nullable: true })
  domain!: string;

  @Column({ type: 'text', nullable: true })
  city!: string;

  @Column({ type: 'text', nullable: true })
  country!: string;

  @Column({ type: 'boolean', default: false })
  tdh_sync!: boolean;

  @Column({ type: 'boolean', default: false })
  block_sync!: boolean;

  @CreateDateColumn()
  created_at?: Time;

  @UpdateDateColumn()
  updated_at?: Time;
}
