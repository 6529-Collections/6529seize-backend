import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { WALLET_CONSOLIDATIONS_TABLE } from '../constants';

@Entity(WALLET_CONSOLIDATIONS_TABLE)
export class WalletConsolidation {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  key!: string;

  @Column({ type: 'text' })
  display!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;
}
