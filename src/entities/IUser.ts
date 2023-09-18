import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { USER_TABLE } from '../constants';

@Entity(USER_TABLE)
export class User {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'text', nullable: true, default: null })
  pfp?: string;

  @Column({ type: 'text', nullable: true, default: null })
  banner_1?: string;

  @Column({ type: 'text', nullable: true, default: null })
  banner_2?: string;

  @Column({ type: 'text', nullable: true, default: null })
  website?: string;
}
