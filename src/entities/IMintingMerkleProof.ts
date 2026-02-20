import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MINTING_MERKLE_PROOFS_TABLE } from '@/constants';

@Entity({ name: MINTING_MERKLE_PROOFS_TABLE })
@Index(['merkle_root', 'address'], { unique: true })
@Index(['merkle_root'])
@Index(['address'])
export class MintingMerkleProof {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: number;

  @Column({ type: 'varchar', length: 66 })
  merkle_root!: string;

  @Column({ type: 'varchar', length: 42 })
  address!: string;

  @Column({ type: 'json' })
  proofs!: unknown;
}
