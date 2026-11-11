import {
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITIONS_TABLE
} from '@/constants';
import { CompetitionLifecycle } from '@/entities/ICompetition';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const logger = Logger.get('COMPETITION_PUBLICATION_CAPACITY');

/**
 * Caps on competitions published at the same time (lifecycle PUBLISHED,
 * which includes paused ones; ended, cancelled and archived ones do not
 * count), checked when a draft is published:
 * - per wave, `COMPETITION_MAX_PUBLISHED_PER_WAVE`, default 25;
 * - per creator profile (who created the draft),
 *   `COMPETITION_MAX_PUBLISHED_PER_CREATOR`, default 50.
 * A wave runs one or a few competitions at a time, so both leave ample room.
 * `0` turns a cap off.
 */
export const COMPETITION_PUBLISHED_LIMIT_DEFAULTS = {
  perWave: 25,
  perCreator: 50
} as const;

export const COMPETITION_PUBLISHED_LIMIT_CODE = 'PUBLISHED_COMPETITION_LIMIT';

function limitFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  logger.warn(`Invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

export function competitionPublishedLimits(
  env: NodeJS.ProcessEnv = process.env
): { perWave: number; perCreator: number } {
  return {
    perWave: limitFromEnv(
      env,
      'COMPETITION_MAX_PUBLISHED_PER_WAVE',
      COMPETITION_PUBLISHED_LIMIT_DEFAULTS.perWave
    ),
    perCreator: limitFromEnv(
      env,
      'COMPETITION_MAX_PUBLISHED_PER_CREATOR',
      COMPETITION_PUBLISHED_LIMIT_DEFAULTS.perCreator
    )
  };
}

export class CompetitionPublicationCapacity extends LazyDbAccessCompatibleService {
  constructor(
    sqlExecutorGetter: ConstructorParameters<
      typeof LazyDbAccessCompatibleService
    >[0],
    private readonly limits: () => {
      perWave: number;
      perCreator: number;
    } = competitionPublishedLimits
  ) {
    super(sqlExecutorGetter);
  }

  /**
   * Rejects publishing `competitionId` with 409 when its wave or its creator
   * already has the maximum number of published competitions. The creator
   * is whoever created the draft; `actorId` stands in when that is unknown.
   * Concurrent publications of different drafts can each pass the check, so
   * the caps can be exceeded by the number of simultaneous publish requests.
   */
  async assertCanPublish(
    {
      competitionId,
      waveId,
      actorId
    }: { competitionId: string; waveId: string; actorId: string },
    ctx: RequestContext
  ): Promise<void> {
    const { perWave, perCreator } = this.limits();
    const options = { wrappedConnection: ctx.connection };
    if (perWave > 0) {
      const inWave = await this.count(
        `select count(*) as cnt from ${COMPETITIONS_TABLE}
         where wave_id = :waveId and lifecycle = :published and id <> :competitionId`,
        { waveId, competitionId },
        options
      );
      if (inWave >= perWave)
        throw new CustomApiCompliantException(
          409,
          `This wave already has ${inWave} published decisions, the most allowed at once (${perWave}). End or archive one before publishing another.`,
          COMPETITION_PUBLISHED_LIMIT_CODE,
          { limit: perWave, scope: 'wave' }
        );
    }
    if (perCreator > 0) {
      const creator =
        (
          await this.db.oneOrNull<{ created_by: string | null }>(
            `select created_by from ${COMPETITION_CONFIG_VERSIONS_TABLE}
             where competition_id = :competitionId and version = 1`,
            { competitionId },
            options
          )
        )?.created_by ?? actorId;
      const byCreator = await this.count(
        `select count(*) as cnt from ${COMPETITIONS_TABLE} c
         join ${COMPETITION_CONFIG_VERSIONS_TABLE} v
           on v.competition_id = c.id and v.version = 1
         where c.lifecycle = :published and v.created_by = :creator and c.id <> :competitionId`,
        { creator, competitionId },
        options
      );
      if (byCreator >= perCreator)
        throw new CustomApiCompliantException(
          409,
          `This decision's creator already has ${byCreator} published decisions, the most allowed at once (${perCreator}). End or archive one before publishing another.`,
          COMPETITION_PUBLISHED_LIMIT_CODE,
          { limit: perCreator, scope: 'creator' }
        );
    }
  }

  private async count(
    sql: string,
    params: Record<string, unknown>,
    options: { wrappedConnection: RequestContext['connection'] }
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ cnt: number | string }>(
      sql,
      { ...params, published: CompetitionLifecycle.PUBLISHED },
      options
    );
    return Number(row?.cnt ?? 0);
  }
}

export const competitionPublicationCapacity =
  new CompetitionPublicationCapacity(dbSupplier);
