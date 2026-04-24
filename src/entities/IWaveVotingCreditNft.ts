import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE
} from '@/constants';

@Entity(WAVE_VOTING_CREDIT_NFTS_TABLE)
@Index('idx_wave_voting_credit_nfts_wave_id', ['wave_id'])
@Index('idx_wave_voting_credit_nfts_contract_token_id', [
  'contract',
  'token_id'
])
export class WaveVotingCreditNftEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly contract!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly token_id!: number;
}

@Entity(WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE)
@Index('idx_wave_voting_credit_nfts_archive_wave_archive_id', [
  'wave_archive_id'
])
@Index('idx_wave_voting_credit_nfts_archive_wave_id', ['wave_id'])
export class WaveVotingCreditNftArchiveEntity {
  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly wave_archive_id!: number;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly contract!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly token_id!: number;
}
