/** Permanent native-backed compatibility view shapes; no physical schema registration. */
import {
  WaveOutcomeCredit,
  WaveOutcomeSubType,
  WaveOutcomeType
} from './IWave';
export interface WaveDecisionEntity {
  readonly decision_time: number;
  readonly wave_id: string;
}
export interface WaveDecisionWinnerDropEntity {
  readonly decision_time: number;
  readonly drop_id: string;
  readonly ranking: number;
  readonly final_vote: number;
  readonly prizes: WaveDecisionWinnerPrize[];
  readonly wave_id: string;
}

export interface WaveDecisionWinnerDropWithSaleEntity extends WaveDecisionWinnerDropEntity {
  readonly sale_time: number | null;
  readonly sale_price: number | null;
  readonly sale_price_currency: string | null;
}

export interface WaveDecisionWinnerPrize {
  type: WaveOutcomeType;
  subtype: WaveOutcomeSubType | null;
  description: string;
  credit: WaveOutcomeCredit | null;
  rep_category: string | null;
  amount: number | null;
}
