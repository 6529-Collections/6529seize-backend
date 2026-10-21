jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { WAVE_SCORE_REFRESH_REQUESTS_TABLE } from '@/constants';
import { reportLoopHealth } from '@/loop-health';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { observeDirtyRefreshBacklog } from './loop-health';

const now = Date.now();
const row = (wave_id: string, dirty_at: number, attempts: number) => ({
  wave_id,
  reason: 'test',
  dirty_at,
  attempts,
  last_error: attempts ? 'failed' : null,
  created_at: now - 900_000,
  updated_at: now
});
describeWithSeed(
  'wave score durable health evidence',
  [
    {
      table: WAVE_SCORE_REFRESH_REQUESTS_TABLE,
      rows: [row('failed', now - 700_000, 9), row('recent', now - 60_000, 0)]
    }
  ],
  () => {
    beforeEach(() => jest.clearAllMocks());
    it('retains failed persisted versions until they are actually removed', async () => {
      await observeDirtyRefreshBacklog();
      expect(reportLoopHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pending: true,
          oldestPendingAt: Math.floor((now - 700_000) / 1000)
        })
      );
      await sqlExecutor.execute(
        `delete from ${WAVE_SCORE_REFRESH_REQUESTS_TABLE} where wave_id = :id`,
        { id: 'failed' }
      );
      await observeDirtyRefreshBacklog();
      expect(reportLoopHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pending: true,
          oldestPendingAt: Math.floor((now - 60_000) / 1000)
        })
      );
      await sqlExecutor.execute(
        `delete from ${WAVE_SCORE_REFRESH_REQUESTS_TABLE}`
      );
      await observeDirtyRefreshBacklog();
      expect(reportLoopHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: 'dirty_refresh',
          pending: false
        })
      );
    });
  }
);
