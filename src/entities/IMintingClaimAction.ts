import { MINTING_CLAIM_ACTIONS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(MINTING_CLAIM_ACTIONS_TABLE)
@Index('minting_claim_actions_contract_token_id_idx', ['contract', 'token_id'])
@Index(
  'minting_claim_actions_contract_token_id_action_uq',
  ['contract', 'token_id', 'action'],
  { unique: true }
)
export class MintingClaimActionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @Column({ type: 'int' })
  readonly token_id!: number;

  @Column({ type: 'varchar', length: 32 })
  readonly action!: string;

  @Column({ type: 'boolean', default: false })
  readonly completed!: boolean;

  @Column({ type: 'varchar', length: 42 })
  readonly created_by_wallet!: string;

  @Column({ type: 'varchar', length: 42 })
  readonly updated_by_wallet!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
