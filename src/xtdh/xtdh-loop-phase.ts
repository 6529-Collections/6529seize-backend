export const XTDH_LOOP_PHASE = {
  UNIVERSE: 'universe',
  STATS: 'stats'
} as const;

export type XTdhLoopPhase =
  (typeof XTDH_LOOP_PHASE)[keyof typeof XTDH_LOOP_PHASE];

export interface XTdhLoopMessage {
  readonly phase?: XTdhLoopPhase;
  readonly queued_at_ms?: number;
}

export function isXTdhLoopPhase(value: unknown): value is XTdhLoopPhase {
  return value === XTDH_LOOP_PHASE.UNIVERSE || value === XTDH_LOOP_PHASE.STATS;
}
