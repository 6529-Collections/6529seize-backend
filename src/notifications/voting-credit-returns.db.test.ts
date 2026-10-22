import { Logger } from '@/logging';
import type { RequestContext } from '@/request.context';
import { randomUUID } from 'node:crypto';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_TABLE,
  VOTING_CREDIT_RELEASES_TABLE,
  VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  VotingCreditReturnsDb,
  CREDIT_RETURN_BATCH_SIZE
} from './voting-credit-returns.db';
import { PushNotificationOutboxDb } from './push-notification-outbox.db';
import type { VotingCreditsReturnedNotificationData } from './user-notification.types';

const competitionId = '10000000-0000-4000-8000-000000000001';
const entryId = '20000000-0000-4000-8000-000000000001';
const now = 1000;

describeWithSeed(
  'Voting credit return snapshots and resumable delivery',
  [
    {
      table: COMPETITIONS_TABLE,
      rows: [
        {
          id: competitionId,
          wave_id: 'hub',
          legacy_wave_id: null,
          storage_mode: 'NATIVE',
          execution_mode: 'ACTIVE',
          type: 'RANK',
          lifecycle: 'PUBLISHED',
          title: 'The Memes - Main Stage',
          config_version: 1,
          participation_config: {},
          voting_config: { credit_scope: 'WAVE', credit_type: 'TDH' },
          decision_config: {},
          winner_config: {},
          outcome_config: [],
          created_at: 0,
          updated_at: 0
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: competitionId,
          wave_id: 'hub',
          drop_id: 'artwork',
          submitter_id: 'author',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 0
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'artwork',
          wave_id: 'hub',
          author_id: 'author',
          title: 'Freedom To Transcend',
          created_at: 0,
          parts_count: 1,
          drop_type: 'COMPETITION'
        }
      ]
    }
  ],
  () => {
    const repo = new VotingCreditReturnsDb(() => sqlExecutor);
    const outbox = new PushNotificationOutboxDb(() => sqlExecutor);
    const capture = (
      reason: VotingCreditsReturnedNotificationData['reason'] = 'WIN',
      actorId = 'author'
    ) =>
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.capture(
          { competitionId, entryId, reason, actorId, occurredAt: now },
          { connection }
        )
      );
    async function vote(profile: string, value: number) {
      await sqlExecutor.bulkInsert(
        COMPETITION_VOTES_TABLE,
        [
          {
            id: randomUUID(),
            competition_id: competitionId,
            entry_id: entryId,
            voter_profile_id: profile,
            value,
            credit_spent: Math.abs(value),
            created_at: 0,
            updated_at: 0
          }
        ],
        [
          'id',
          'competition_id',
          'entry_id',
          'voter_profile_id',
          'value',
          'credit_spent',
          'created_at',
          'updated_at'
        ]
      );
    }

    it('captures current absolute allocations once and survives hard deletion of content and votes', async () => {
      await vote('positive', 500);
      await vote('negative', -300);
      await vote('withdrawn', 0);
      await capture('AUTHOR_DELETED');
      await capture('AUTHOR_DELETED');
      await sqlExecutor.execute(`delete from ${COMPETITION_VOTES_TABLE}`);
      await sqlExecutor.execute(`delete from ${DROPS_TABLE}`);
      await sqlExecutor.execute(`delete from ${COMPETITION_ENTRIES_TABLE}`);
      const deliver = jest.fn().mockResolvedValue(undefined);
      expect(await repo.processBatch(deliver, now)).toBe(true);
      expect(deliver.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          {
            recipientId: 'positive',
            data: expect.objectContaining({
              amount: 500,
              submission_title: 'Freedom To Transcend',
              reason: 'AUTHOR_DELETED'
            })
          },
          {
            recipientId: 'negative',
            data: expect.objectContaining({ amount: 300 })
          }
        ])
      );
      expect(deliver.mock.calls[0][0]).toHaveLength(2);
      expect(await repo.processBatch(deliver, now)).toBe(false);
      expect(
        await sqlExecutor.execute(
          `select * from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}`
        )
      ).toEqual([]);
    });

    it.each(['DROP', 'WINNER', 'OTHER_AUTHOR'])(
      'does not notify when no eligible release occurs (%s)',
      async (kind) => {
        await vote('voter', 500);
        if (kind === 'DROP')
          await sqlExecutor.execute(
            `update ${COMPETITIONS_TABLE} set voting_config=json_set(voting_config,'$.credit_scope','DROP')`
          );
        if (kind === 'WINNER')
          await sqlExecutor.execute(
            `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER'`
          );
        await capture(
          'AUTHOR_DELETED',
          kind === 'OTHER_AUTHOR' ? 'admin' : 'author'
        );
        expect(await repo.processBatch(jest.fn(), now)).toBe(false);
      }
    );

    it('rolls back capture with the underlying action', async () => {
      await vote('voter', 500);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await repo.capture(
            { competitionId, entryId, reason: 'WIN', occurredAt: now },
            { connection }
          );
          throw new Error('action failed');
        })
      ).rejects.toThrow('action failed');
      expect(
        await sqlExecutor.execute(
          `select * from ${VOTING_CREDIT_RELEASES_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select * from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}`
        )
      ).toEqual([]);
    });

    it('retries a failed page without duplicate committed effects and bounds each page', async () => {
      const count = CREDIT_RETURN_BATCH_SIZE + 1;
      for (let i = 0; i < count; i++)
        await vote(`voter-${String(i).padStart(5, '0')}`, i + 1);
      await capture();
      await expect(
        repo.processBatch(async (_, ctx) => {
          await outbox.enqueueMany([41, 42], ctx);
          throw new Error('worker crashed');
        }, now)
      ).rejects.toThrow('worker crashed');
      expect(
        await sqlExecutor.execute(
          `select * from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`
        )
      ).toEqual([]);
      expect(await repo.processBatch(jest.fn(), now)).toBe(false);
      const delivered: string[] = [];
      const deliver = jest.fn(
        async (rows: { recipientId: string }[], ctx: RequestContext) => {
          delivered.push(...rows.map((row) => row.recipientId));
          // The header lock excludes a concurrent consumer from this release.
          expect(await repo.processBatch(jest.fn(), now + 60_000)).toBe(false);
          await outbox.enqueueMany([delivered.length], ctx);
        }
      );
      expect(await repo.processBatch(deliver, now + 60_000)).toBe(true);
      expect(deliver.mock.calls[0][0]).toHaveLength(CREDIT_RETURN_BATCH_SIZE);
      await capture();
      const pending = await sqlExecutor.execute(
        `select * from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}`
      );
      expect(pending).toHaveLength(1);
      expect(await repo.processBatch(deliver, now + 60_000)).toBe(true);
      expect(deliver.mock.calls[1][0]).toHaveLength(1);
      expect(new Set(delivered).size).toBe(count);
      expect(await repo.processBatch(deliver, now + 60_000)).toBe(false);
      expect(await outbox.oldestPendingAt()).not.toBeNull();
    });
    it('snapshots 10,000 voters with a fixed number of SQL statements and no application fanout', async () => {
      const rows = Array.from({ length: 10_000 }, (_, index) => ({
        id: randomUUID(),
        competition_id: competitionId,
        entry_id: entryId,
        voter_profile_id: `scale-${index}`,
        value: index + 1,
        credit_spent: index + 1,
        created_at: 0,
        updated_at: 0
      }));
      await sqlExecutor.bulkInsert(COMPETITION_VOTES_TABLE, rows, [
        'id',
        'competition_id',
        'entry_id',
        'voter_profile_id',
        'value',
        'credit_spent',
        'created_at',
        'updated_at'
      ]);
      const benchmarkRepo = new VotingCreditReturnsDb(() => sqlExecutor);
      const rollback = new Error('benchmark rollback');
      async function measure(withCapture: boolean) {
        const samples: number[] = [];
        for (let sample = 0; sample < 10; sample++) {
          const started = performance.now();
          try {
            await sqlExecutor.executeNativeQueriesInTransaction(
              async (connection) => {
                await sqlExecutor.execute(
                  `select id from ${COMPETITIONS_TABLE} where id=:competitionId for update`,
                  { competitionId },
                  { wrappedConnection: connection }
                );
                if (withCapture)
                  await benchmarkRepo.capture(
                    { competitionId, entryId, reason: 'WIN', occurredAt: now },
                    { connection }
                  );
                await sqlExecutor.execute(
                  `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER' where id=:entryId`,
                  { entryId },
                  { wrappedConnection: connection }
                );
                throw rollback;
              }
            );
          } catch (error) {
            if (error !== rollback) throw error;
          }
          samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        return (
          Math.round(samples[Math.ceil(samples.length * 0.95) - 1] * 100) / 100
        );
      }
      const baselineP95 = await measure(false);
      const capturedP95 = await measure(true);
      const execute = jest.spyOn(sqlExecutor, 'execute');
      const started = performance.now();
      try {
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          benchmarkRepo.capture(
            { competitionId, entryId, reason: 'WIN', occurredAt: now },
            { connection }
          )
        );
        const elapsed = performance.now() - started;
        expect(execute).toHaveBeenCalledTimes(2);
        Logger.get('CREDIT_RETURN_BENCHMARK').info(
          JSON.stringify({
            benchmark: 'credit-return-capture',
            voters: rows.length,
            baseline_transaction_p95_ms: baselineP95,
            capture_transaction_p95_ms: capturedP95,
            duration_ms: Math.round(elapsed * 100) / 100,
            sql_statements: execute.mock.calls.length
          })
        );
      } finally {
        execute.mockRestore();
      }
      const [count] = await sqlExecutor.execute<{ count: number }>(
        `select count(*) as count from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}`
      );
      expect(Number(count.count)).toBe(rows.length);
    });
  }
);
