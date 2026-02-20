import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn
} from 'typeorm';
import { MINTING_MERKLE_ROOTS_TABLE } from '@/constants';

@Entity({ name: MINTING_MERKLE_ROOTS_TABLE })
@Index(['card_id', 'contract', 'phase'], { unique: true })
@Index(['merkle_root'])
@Index(['card_id', 'contract'])
export class MintingMerkleRoot {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: number;

  @Column({ type: 'int' })
  card_id!: number;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'varchar', length: 255 })
  phase!: string;

  @Column({ type: 'varchar', length: 66 })
  merkle_root!: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  created_at!: Date;
}
