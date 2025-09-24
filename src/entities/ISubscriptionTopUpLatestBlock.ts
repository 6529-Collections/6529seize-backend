import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_TABLE } from '../constants';

@Entity(SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_TABLE)
export class SubscriptionTopUpLatestBlock {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'datetime', nullable: true })
  block_timestamp?: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;
}
