import { CollectingFamily } from '@/collecting/collecting.types';

/** CPU/memory bounds, not financial limits. Every candidate portfolio is replayed whole. */
export const COLLECT_TDH_TARGET_LIMITS = {
  candidates: 2000,
  evaluations: 128,
  replay_work: 10000000,
  frontier: 2048,
  generated_states: 20000,
  duration_ms: 20000,
  quantity_per_asset: 9999
} as const;

export interface CollectingTdhTargetRequest {
  profile_id: string;
  recipient: string;
  target_tdh: string;
  target_mode: 'TOTAL_AT_DEADLINE' | 'ADDITIONAL_OVER_BASELINE';
  horizon_days: 1 | 30 | 90 | 365;
  families: CollectingFamily[];
  budget_wei?: string;
}

/** Trusted indexed, signed-order amounts. Never supplied by the requesting client. */
export interface CollectingTdhTargetCandidate {
  id: string;
  asset_key: string;
  maker: string;
  quantity_step: number;
  available_quantity: number;
  step_cost_wei: string;
  step_fees_wei: string;
}

export type CollectingTdhTargetStop =
  | 'COMPLETE'
  | 'EVALUATION_LIMIT'
  | 'WORK_LIMIT'
  | 'TIME_LIMIT'
  | 'FRONTIER_LIMIT';

export interface CollectingTdhTargetSelection {
  candidate: CollectingTdhTargetCandidate;
  quantity: number;
}
