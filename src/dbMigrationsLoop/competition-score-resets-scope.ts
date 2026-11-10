import { compareCompetitionScoreHistory } from '@/competitions/competition-score-history-compare';
import { competitionScoreResetRepository } from '@/competitions/competition-score-reset.repository';

export const COMPETITION_SCORE_RESETS_SCOPE =
  'competition-score-resets-backfill';

/** Operator-only; deploy all reset writers before starting the resumable copy. */
export async function runCompetitionScoreResetsScope(
  event: Record<string, unknown>
) {
  const action = event.action ?? 'status';
  if (
    typeof action !== 'string' ||
    !['status', 'backfill', 'enable', 'disable', 'compare'].includes(action)
  ) {
    throw new Error(
      'Expected action status, backfill, enable, disable or compare'
    );
  }
  const limit = event.limit === undefined ? 10 : event.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  if (
    (action === 'backfill' || action === 'enable') &&
    event.writers_deployed !== true
  ) {
    throw new Error(
      'Confirm all reset writers are deployed before backfill or cutover'
    );
  }
  if (action === 'compare')
    return compareCompetitionScoreHistory(
      event.competition_id,
      event.explain === true
    );
  let processed = 0;
  if (action === 'backfill') {
    while (
      processed < limit &&
      (await competitionScoreResetRepository.backfillNext())
    )
      processed++;
  } else if (action === 'enable' || action === 'disable') {
    await competitionScoreResetRepository.setReadsEnabled(action === 'enable');
  }
  return { processed, ...(await competitionScoreResetRepository.progress({})) };
}
