jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  NFTDELEGATION_BLOCKS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { reportLoopHealth } from '@/loop-health';
import { observeDecisionBacklogs } from './loop-health';
import { DelegationsLoopHealth } from '@/delegationsLoop/delegations-loop-health';

const now = Date.now();
const competition = (id: string, next: number | null) => ({
  id,
  wave_id: 'hub',
  legacy_wave_id: null,
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
    {
      table: COMPETITIONS_TABLE,
      rows: [
        {
          ...competition('due', now - 180_000),
          legacy_wave_id: 'original-primary'
        },
        competition('no-decision', null),
        { ...competition('missing-schedule', null), decision_config: {} },
        {
          ...competition('disabled', now - 900_000),
          execution_mode: 'DISABLED'
        },
        {
          ...competition('unpublished', now - 900_000),
          lifecycle: 'DRAFT'
        },
        {
          ...competition('approve', now - 900_000),
          type: 'APPROVE'
        },
        {
          ...competition('ended', now - 900_000),
          lifecycle: 'ENDED'
        }
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
        },
        {
          id: 'delivered',
          competition_id: 'due',
          wave_id: 'hub',
          semantic_key: 'delivered',
          event: {},
          created_at: now - 900_000,
          next_attempt_at: now,
          lease_until: null,
          delivered_at: now,
          lease_token: null,
          attempts: 1
        }
      ]
    }
  ],
  () => {
    beforeEach(() => jest.clearAllMocks());
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
    it('monitors active native decisions including original primaries and leased/backed-off native publication only', async () => {
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
          oldestPendingAt: Math.floor((now - 240_000) / 1000)
        })
      );
    });
    it('retains a future native obligation for independent deadline evaluation', async () => {
      const future = Date.now() + 60_000;
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
        `update ${COMPETITIONS_TABLE} set decision_config = '{"next_decision_time": null}'`
      );
      await sqlExecutor.execute(
        `update ${COMPETITION_OUTBOX_TABLE} set delivered_at = :now`,
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
