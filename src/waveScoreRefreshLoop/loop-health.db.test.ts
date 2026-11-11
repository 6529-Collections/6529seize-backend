jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import {
  WAVE_METRICS_TABLE,
  WAVE_SCORE_REFRESH_REQUESTS_TABLE
} from '@/constants';
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
  created_at: dirty_at,
  updated_at: now
});
describeWithSeed(
  'wave score durable health evidence',
  [
    {
      table: WAVE_SCORE_REFRESH_REQUESTS_TABLE,
      rows: [row('failed', now - 700_000, 9), row('recent', now - 60_000, 0)]
    },
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        { wave_id: 'failed', wave_score_calculated_at: now - 86_400_000 },
        { wave_id: 'recent', wave_score_calculated_at: now - 86_400_000 }
      ]
    }
  ],
  () => {
    beforeEach(() => jest.clearAllMocks());
    it('does not count new dirty versions or failed attempts as refresh progress', async () => {
      await sqlExecutor.execute(
        `delete from ${WAVE_SCORE_REFRESH_REQUESTS_TABLE} where wave_id = :id`,
        { id: 'recent' }
      );
      await sqlExecutor.execute(
        `update ${WAVE_SCORE_REFRESH_REQUESTS_TABLE}
         set dirty_at = :now, updated_at = :now, attempts = attempts + 1
         where wave_id = :id`,
        { id: 'failed', now }
      );
      await observeDirtyRefreshBacklog();
      expect(reportLoopHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pending: true,
          oldestPendingAt: Math.floor((now - 700_000) / 1000)
        })
      );
      await sqlExecutor.execute(
        `update ${WAVE_METRICS_TABLE} set wave_score_calculated_at = :calculatedAt where wave_id = :id`,
        { id: 'failed', calculatedAt: now - 10_000 }
      );
      await observeDirtyRefreshBacklog();
      expect(reportLoopHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pending: true,
          oldestPendingAt: Math.floor((now - 10_000) / 1000)
        })
      );
    });
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
