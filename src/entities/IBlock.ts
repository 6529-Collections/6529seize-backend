import { Column, CreateDateColumn, PrimaryColumn } from 'typeorm';

export interface Block {
  block_number: number;
  created_at: Date;
  block_timestamp: Date;
}

export abstract class BlockEntity {
  @CreateDateColumn()
  created_at?: Date;

  @PrimaryColumn({ type: 'int' })
  block!: number;

  @Column({ type: 'bigint' })
  timestamp!: number;
}
