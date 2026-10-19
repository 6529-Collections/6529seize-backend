jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  NFTDELEGATION_BLOCKS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { reportLoopHealth } from '@/loop-health';
import { observeDecisionBacklogs } from './loop-health';
import { DelegationsLoopHealth } from '@/delegationsLoop/delegations-loop-health';

const now = Date.now();
const competition = (id: string, next: number | null) => ({
  id,
  wave_id: 'hub',
  legacy_wave_id: null,
  storage_mode: 'NATIVE',
  execution_mode: 'ACTIVE',
  type: 'RANK',
  lifecycle: 'PUBLISHED',
  title: 'test',
  description: null,
  participation_config: {},
  voting_config: {},
  decision_config: { next_decision_time: next },
  winner_config: {},
  outcome_config: [],
  config_version: 1,
  participation_starts_at: null,
  participation_ends_at: null,
  voting_starts_at: null,
  voting_ends_at: null,
  created_at: now,
  updated_at: now,
  published_at: now,
  ended_at: null,
  cancelled_at: null,
  archived_at: null
});
describeWithSeed(
  'decision monitoring reads persisted backlog',
  [
    {
      table: NFTDELEGATION_BLOCKS_TABLE,
      rows: [{ block: 123, timestamp: Math.floor(now / 1000) }]
    },
    withWaves([
      aWave(
        { next_decision_time: now - 120_000 },
        { id: 'legacy', name: 'legacy' }
      )
    ]),
    {
      table: COMPETITIONS_TABLE,
      rows: [
        competition('due', now - 180_000),
        competition('no-decision', null)
      ]
    },
    {
      table: COMPETITION_OUTBOX_TABLE,
      rows: [
        {
          id: 'outbox',
          competition_id: 'due',
          wave_id: 'hub',
          semantic_key: 'pending',
          event: {},
          created_at: now - 240_000,
          next_attempt_at: now + 3600_000,
          lease_until: now + 600_000,
          delivered_at: null,
          lease_token: 'lease',
          attempts: 5
        }
      ]
    },
    {
      table: COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
      rows: [
        {
          id: 'legacy-effects',
          competition_id: 'legacy',
          wave_id: 'legacy',
          payload: {},
          created_at: now - 300_000,
          completed_at: null,
          lease_until: now + 600_000,
          lease_token: 'lease',
          attempts: 2
        }
      ]
    }
  ],
  () => {
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
    });
    afterEach(() => {
      delete process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
    });
    it('reads the delegation checkpoint through the bounded monitoring reader', async () => {
      await DelegationsLoopHealth.start(false);
      expect(reportLoopHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'indexing',
          pending: true,
          oldestPendingAt: Math.floor(now / 1000),
          recovery: 'automatic'
        })
      );
    });
    it('keeps due work and leased/backed-off publication visible while excluding JSON null schedules', async () => {
      await observeDecisionBacklogs();
      expect(reportLoopHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'decisions',
          pending: true,
          oldestPendingAt: Math.floor((now - 180_000) / 1000)
        })
      );
      expect(reportLoopHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'publication',
          pending: true,
          oldestPendingAt: Math.floor((now - 300_000) / 1000)
        })
      );
    });
    it('retains a future native obligation for independent deadline evaluation', async () => {
      const future = Date.now() + 60_000;
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set next_decision_time = null`
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = json_object('next_decision_time', :future) where id = 'due'`,
        { future }
      );
      await observeDecisionBacklogs();
      expect(reportLoopHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'decisions',
          pending: false,
          nextDueAt: Math.floor(future / 1000),
          deadlineAt: Math.floor(future / 1000) + 300
        })
      );
    });
    it('verifies recovery only after all persisted due work and delivery work clear', async () => {
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set next_decision_time = null`
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = '{"next_decision_time": null}'`
      );
      await sqlExecutor.execute(
        `update ${COMPETITION_OUTBOX_TABLE} set delivered_at = :now`,
        { now }
      );
      await sqlExecutor.execute(
        `update ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} set completed_at = :now`,
        { now }
      );
      await observeDecisionBacklogs();
      expect(reportLoopHealth).toHaveBeenCalledTimes(2);
      expect(
        jest
          .mocked(reportLoopHealth)
          .mock.calls.every(([value]) => !value.pending)
      ).toBe(true);
    });
  }
);
