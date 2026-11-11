import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { redisIncrementWithExpiry } from '@/redis';

const logger = Logger.get('COMPETITION_VOTE_CHANGE_BUDGET');

/**
 * Vote changes one voter may make in one competition per minute, across all
 * of its entries. Each change appends vote history, score history and an
 * outbox event, so the count bounds those writes per voter.
 *
 * `COMPETITION_VOTE_CHANGES_PER_MINUTE`, default 120: two changes every
 * second for a whole minute, well beyond what a person sets by hand even
 * with quick voting, which shows each entry before its vote. `0` turns the
 * budget off.
 */
export const COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT = 120;
const WINDOW_SECONDS = 60;

export const COMPETITION_VOTE_CHANGE_LIMIT_CODE = 'VOTE_CHANGE_LIMIT';

export function competitionVoteChangesPerMinute(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.COMPETITION_VOTE_CHANGES_PER_MINUTE?.trim();
  if (!raw) return COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  logger.warn(
    `Invalid COMPETITION_VOTE_CHANGES_PER_MINUTE=${JSON.stringify(raw)}; using ${COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT}`
  );
  return COMPETITION_VOTE_CHANGES_PER_MINUTE_DEFAULT;
}

export class CompetitionVoteChangeBudget {
  constructor(
    private readonly increment: typeof redisIncrementWithExpiry = (
      key,
      ttlSeconds
    ) => redisIncrementWithExpiry(key, ttlSeconds),
    private readonly now: () => number = Date.now,
    private readonly limit: () => number = competitionVoteChangesPerMinute
  ) {}

  /**
   * Counts one vote change by this voter in this competition, or rejects it
   * with 429 when the current minute's budget is spent. Call it only for a
   * change (a new value), inside the vote's transaction, before writing.
   * While Redis is unavailable changes are admitted.
   */
  async spend(competitionId: string, voterProfileId: string): Promise<void> {
    const limit = this.limit();
    if (limit <= 0) return;
    const now = this.now();
    const window = Math.floor(now / (WINDOW_SECONDS * 1000));
    const count = await this.increment(
      `competition_vote_changes:{${competitionId}}:${voterProfileId}:${window}`,
      WINDOW_SECONDS + 1
    );
    if (count === null || count <= limit) return;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((window + 1) * WINDOW_SECONDS * 1000 - now) / 1000)
    );
    throw new CustomApiCompliantException(
      429,
      `Too many vote changes in this decision: at most ${limit} per minute. Try again in ${retryAfterSeconds} seconds.`,
      COMPETITION_VOTE_CHANGE_LIMIT_CODE,
      { retry_after_seconds: retryAfterSeconds }
    );
  }
}

export const competitionVoteChangeBudget = new CompetitionVoteChangeBudget();
