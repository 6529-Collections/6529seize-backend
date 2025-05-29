import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index
} from 'typeorm';
import { DROP_REACTIONS_TABLE } from '../constants';

@Entity(DROP_REACTIONS_TABLE)
@Index(['profile_id', 'wave_id', 'drop_id'], { unique: true })
@Index(['wave_id', 'drop_id'])
export class DropReactionsEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  wave_id!: string;

  @Column({ type: 'varchar', length: 100 })
  drop_id!: string;

  @Column({ type: 'varchar', length: 100 })
  reaction!: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;
}
