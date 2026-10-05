import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  COMPETITION_COMMANDS_TABLE,
  COMPETITION_SIGNATURE_NONCES_TABLE
} from '@/constants';

@Entity(COMPETITION_COMMANDS_TABLE)
export class CompetitionCommandEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly actor_id!: string;

  @Column({ type: 'varchar', length: 64 })
  readonly payload_hash!: string;

  @Column({ type: 'json', nullable: true })
  readonly result!: unknown | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

@Entity(COMPETITION_SIGNATURE_NONCES_TABLE)
export class CompetitionSignatureNonceEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly actor_id!: string;

  @Column({ type: 'bigint' })
  readonly consumed_at!: number;
}
