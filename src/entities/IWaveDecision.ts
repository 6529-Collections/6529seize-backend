import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE
} from '@/constants';
import {
  WaveOutcomeCredit,
  WaveOutcomeSubType,
  WaveOutcomeType
} from './IWave';

@Entity(WAVES_DECISIONS_TABLE)
export class WaveDecisionEntity {
  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly decision_time!: number;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}

@Entity(WAVES_DECISION_WINNER_DROPS_TABLE)
export class WaveDecisionWinnerDropEntity {
  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly decision_time!: number;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'int', nullable: false })
  readonly ranking!: number;

  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly final_vote!: number;

  @Column({ type: 'json', nullable: false })
  readonly prizes!: WaveDecisionWinnerPrize[];

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}

export interface WaveDecisionWinnerPrize {
  type: WaveOutcomeType;
  subtype: WaveOutcomeSubType | null;
  description: string;
  credit: WaveOutcomeCredit | null;
  rep_category: string | null;
  amount: number | null;
}
