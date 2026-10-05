import { COMPETITIONS_TABLE, WAVES_TABLE } from '@/constants';
import { CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export class CompetitionHistoryRepository extends LazyDbAccessCompatibleService {
  public async assertWaveCanBeDeleted(
    waveId: string,
    ctx: RequestContext & Required<Pick<RequestContext, 'connection'>>
  ): Promise<void> {
    const timerName = `${this.constructor.name}->assertWaveCanBeDeleted`;
    ctx.timer?.start(timerName);
    try {
      const options = { wrappedConnection: ctx.connection };
      // Creation takes the same parent lock, so deletion cannot race a new draft.
      await this.db.execute(
        `SELECT id FROM ${WAVES_TABLE} WHERE id = :waveId FOR UPDATE`,
        { waveId },
        options
      );
      const history = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${COMPETITIONS_TABLE} WHERE wave_id = :waveId AND storage_mode = 'NATIVE' LIMIT 1 FOR SHARE`,
        { waveId },
        options
      );
      if (history) {
        throw new CustomApiCompliantException(
          409,
          'This wave contains competition history and cannot be deleted. Archive its competitions instead.'
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionHistoryRepository = new CompetitionHistoryRepository(
  dbSupplier
);
