import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IDENTITY_MUTES_TABLE } from '@/constants';

@Entity(IDENTITY_MUTES_TABLE)
@Index(['muter_id', 'muted_identity_id'], { unique: true })
export class IdentityMuteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: bigint;

  @Index(`${IDENTITY_MUTES_TABLE}_muter_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly muter_id!: string;

  @Index(`${IDENTITY_MUTES_TABLE}_muted_identity_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly muted_identity_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
