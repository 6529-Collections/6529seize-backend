import { Logger } from '@/logging';

const logger = Logger.get('WAVE_DECISION_LOOP_BUDGET');

/**
 * How one waveDecisionExecutionLoop invocation (15 minute timeout, one run a
 * minute, never two at once) shares its time:
 * 1. outbox delivery first, for up to `WAVE_DECISION_LOOP_DISPATCH_FIRST_MS`
 *    (default 60 s), so events are delivered every invocation however long
 *    the decision pass takes;
 * 2. the decision pass, which starts no competition after
 *    `WAVE_DECISION_LOOP_DECISIONS_BUDGET_MS` (default 5 min) or once less
 *    than the final delivery's share is left, and moves on from a competition
 *    still running after `WAVE_DECISION_LOOP_COMPETITION_DEADLINE_MS`
 *    (default 2 min);
 * 3. outbox delivery again, decision results first, with up to four minutes
 *    of what is left.
 * Ordinary passes take seconds and never reach these bounds.
 */
export interface DecisionLoopBudget {
  readonly dispatchFirstMs: number;
  readonly decisionsBudgetMs: number;
  readonly competitionDeadlineMs: number;
  /** The decision pass starts no competition with less than this left. */
  readonly reserveMillis: number;
}

export const DECISION_LOOP_BUDGET_DEFAULTS: DecisionLoopBudget = {
  dispatchFirstMs: 60_000,
  decisionsBudgetMs: 300_000,
  competitionDeadlineMs: 120_000,
  reserveMillis: 300_000
};

/** Kept free at the end of an invocation, after the last delivery. */
export const DECISION_LOOP_SAFETY_MARGIN_MS = 30_000;

function positiveMillis(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  logger.warn(`Invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

export function decisionLoopBudget(
  env: NodeJS.ProcessEnv = process.env
): DecisionLoopBudget {
  return {
    dispatchFirstMs: positiveMillis(
      env,
      'WAVE_DECISION_LOOP_DISPATCH_FIRST_MS',
      DECISION_LOOP_BUDGET_DEFAULTS.dispatchFirstMs
    ),
    decisionsBudgetMs: positiveMillis(
      env,
      'WAVE_DECISION_LOOP_DECISIONS_BUDGET_MS',
      DECISION_LOOP_BUDGET_DEFAULTS.decisionsBudgetMs
    ),
    competitionDeadlineMs: positiveMillis(
      env,
      'WAVE_DECISION_LOOP_COMPETITION_DEADLINE_MS',
      DECISION_LOOP_BUDGET_DEFAULTS.competitionDeadlineMs
    ),
    reserveMillis: DECISION_LOOP_BUDGET_DEFAULTS.reserveMillis
  };
}

/**
 * The final delivery's share: what is left before the safety margin, never
 * more (the dispatcher caps it at four minutes itself). 0 means there is no
 * time left and the delivery is skipped; undefined means the invocation's
 * remaining time is unknown and the dispatcher's own cap applies.
 */
export function finalDispatchBudgetMs(
  remainingMillis: number | undefined
): number | undefined {
  if (remainingMillis === undefined) return undefined;
  return Math.max(0, remainingMillis - DECISION_LOOP_SAFETY_MARGIN_MS);
}
