import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROP_POLLS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { dropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { installLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { AuthenticationContext } from '@/auth-context';
import { dropsService } from '@/api/drops/drops.api.service';
import { reactionsService } from '@/api/drops/reactions.service';
import { deleteDrop } from '@/drops/delete-drop.use-case';
import { Timer } from '@/time';
import {
  readCommitted,
  runWriteTransaction,
  withRequestDeadline,
  WriteBusyException
} from '@/api/write-transaction-budget';

/**
 * API write transactions run with an execution budget inside a request:
 * lock waits give up after 10 s, the request deadline (5 s before the
 * Lambda's) rolls the transaction back, and both answer 503 + Retry-After.
 */

const author = 'budget-author';
const wave = aWave(
  { type: WaveType.CHAT, chat_enabled: true, created_by: author },
  { id: 'budget-wave', name: 'Budget wave' }
);
const dmWave = aWave(
  { type: WaveType.CHAT, chat_enabled: true, is_direct_message: true },
  { id: 'budget-dm-wave', name: 'Budget DM' }
);
const rankWave = aWave(
  { type: WaveType.RANK },
  { id: 'budget-rank-wave', name: 'Budget rank' }
);
const competitionId = '11000000-0000-4000-8000-0000000000b1';
const reactor = 'budget-reactor';

function chatDrop(
  content: string,
  overrides: Partial<CreateOrUpdateDropModel> = {}
): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: wave.id,
    author_id: author,
    author_identity: author,
    drop_type: DropType.CHAT,
    signature: null,
    title: null,
    reply_to: null,
    parts: [{ content, quoted_drop: null, media: [] }],
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    mentioned_groups: [],
    referenced_nfts: [],
    is_additional_action_promised: null,
    ...overrides
  };
}

/** A post through the use case under the request budget. */
function budgetedPost(
  model: CreateOrUpdateDropModel,
  after?: (dropId: string, connection: ConnectionWrapper<any>) => Promise<void>
) {
  return withRequestDeadline(30_000, () =>
    runWriteTransaction((options) =>
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        const created = await createOrUpdateDrop.execute(model, false, {
          connection,
          prePublication: { trustedSystem: true }
        });
        await after?.(created.drop_id, connection);
        return created;
      }, options)
    )
  );
}

async function threadIdOf(connection: ConnectionWrapper<unknown>) {
  const row = await sqlExecutor.oneOrNull<{ id: number | string }>(
    'select connection_id() as id',
    undefined,
    { wrappedConnection: connection }
  );
  return Number(row?.id);
}

/**
 * Resolves with how long the server took to end `threadId`'s transaction.
 * A connection destroyed in the middle of a lock wait is noticed by the
 * server only when that wait ends: at most the 10 s lock-wait limit.
 */
async function untilNoOpenTransaction(threadId: number): Promise<number> {
  const started = performance.now();
  while ((await openTransactionsOf(threadId)) > 0) {
    if (performance.now() - started > 12_000) {
      throw new Error('the transaction stayed open');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return performance.now() - started;
}

async function openTransactionsOf(threadId: number): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ n: number | string }>(
    `select count(*) as n from information_schema.innodb_trx
     where trx_mysql_thread_id = :threadId`,
    { threadId }
  );
  return Number(row?.n ?? 0);
}

/** Holds a row lock on the wave row until `release` is called. */
function holdWaveRow() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      await sqlExecutor.execute(
        'select id from waves where id = :id for update',
        { id: wave.id },
        { wrappedConnection: connection }
      );
      locked();
      await released;
    }
  );
  return { isLocked, release, done };
}

/** A budgeted write that waits for the wave row. */
function budgetedWaveRowWrite(
  remainingMillis: number,
  threadIds: number[]
): Promise<void> {
  return withRequestDeadline(remainingMillis, () =>
    runWriteTransaction((options) =>
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        threadIds.push(await threadIdOf(connection));
        await sqlExecutor.execute(
          'select id from waves where id = :id for update',
          { id: wave.id },
          { wrappedConnection: connection }
        );
      }, options)
    )
  );
}

describeWithSeed(
  'API write transaction budget',
  [withWaves([wave, dmWave, rankWave])],
  () => {
    it('runs a real post and a real reaction under the budget', async () => {
      const result = await withRequestDeadline(30_000, () =>
        runWriteTransaction((options) =>
          sqlExecutor.executeNativeQueriesInTransaction(
            (connection) =>
              createOrUpdateDrop.execute(chatDrop('budgeted post'), false, {
                connection,
                prePublication: { trustedSystem: true }
              }),
            options
          )
        )
      );
      const stored = await sqlExecutor.oneOrNull<{ id: string }>(
        `select id from ${DROPS_TABLE} where id = :id`,
        { id: result.drop_id }
      );
      expect(stored?.id).toBe(result.drop_id);

      const reacted = await withRequestDeadline(30_000, () =>
        reactionsService.addReaction(result.drop_id, reactor, ':fire:', {
          authenticationContext: AuthenticationContext.fromProfileId(reactor)
        })
      );
      expect(reacted.id).toBe(result.drop_id);
    });

    it('runs a reply with a quote, a mention and a poll under the budget', async () => {
      const base = await budgetedPost(chatDrop('base'));
      const reply = await budgetedPost(
        chatDrop('reply quoting @someone', {
          reply_to: { drop_id: base.drop_id, drop_part_id: 1 },
          parts: [
            {
              content: 'reply quoting @someone',
              quoted_drop: { drop_id: base.drop_id, drop_part_id: 1 },
              media: []
            }
          ],
          mentioned_users: [{ handle: 'someone' }] as never
        }),
        (dropId, connection) =>
          dropPollsApiService.createPollForDrop(
            {
              poll: {
                options: ['yes', 'no'],
                multichoice: false,
                closing_time: Date.now() + 86_400_000
              },
              dropId,
              waveId: wave.id,
              authorId: author,
              dropType: DropType.CHAT
            },
            {
              connection,
              authenticationContext: AuthenticationContext.fromProfileId(author)
            }
          )
      );
      const poll = await sqlExecutor.oneOrNull<{ drop_id: string }>(
        `select drop_id from ${DROP_POLLS_TABLE} where drop_id = :id`,
        { id: reply.drop_id }
      );
      expect(poll?.drop_id).toBe(reply.drop_id);
    });

    it('runs a post with media under the budget', async () => {
      const created = await budgetedPost(
        chatDrop('with media', {
          parts: [
            {
              content: 'with media',
              quoted_drop: null,
              media: [
                {
                  url: 'https://d3lqz0a4bldqgf.cloudfront.net/drops/budget/test.png',
                  mime_type: 'image/png'
                }
              ]
            }
          ]
        })
      );
      expect(created.drop_id).toBeTruthy();
    });

    it('runs a direct-message post under the budget', async () => {
      const created = await budgetedPost(
        chatDrop('dm', { wave_id: dmWave.id })
      );
      expect(created.drop_id).toBeTruthy();
    });

    it('runs a competition entry post under the budget', async () => {
      const flags = [
        process.env.FEATURE_NATIVE_COMPETITION_WRITES,
        process.env.FEATURE_NATIVE_COMPETITION_EXECUTION
      ];
      process.env.FEATURE_NATIVE_COMPETITION_WRITES = 'true';
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      try {
        await sqlExecutor.execute(
          `insert into ${COMPETITIONS_TABLE}
          (id,wave_id,legacy_wave_id,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,published_at,created_at,updated_at)
          values (:id,:waveId,:waveId,'ACTIVE','RANK','PUBLISHED','Budget',
          :participation,:voting,:decisions,'{}','[]',1,1,1,1)`,
          {
            id: competitionId,
            waveId: rankWave.id,
            participation: JSON.stringify({
              required_metadata: [],
              required_media: []
            }),
            voting: JSON.stringify({
              credit_type: 'TDH',
              credit_scope: 'WAVE',
              credit_nfts: []
            }),
            decisions: JSON.stringify({
              strategy: null,
              next_decision_time: null,
              time_lock_ms: 10,
              winning_min_threshold: null
            })
          }
        );
        await installLegacyCompetitionGetFacade(sqlExecutor);
        const created = await budgetedPost(
          chatDrop('entry', {
            wave_id: rankWave.id,
            drop_type: DropType.PARTICIPATORY,
            title: 'Entry'
          })
        );
        const entry = await sqlExecutor.oneOrNull<{ drop_id: string }>(
          `select drop_id from ${COMPETITION_ENTRIES_TABLE} where drop_id = :id`,
          { id: created.drop_id }
        );
        expect(entry?.drop_id).toBe(created.drop_id);
      } finally {
        [
          'FEATURE_NATIVE_COMPETITION_WRITES',
          'FEATURE_NATIVE_COMPETITION_EXECUTION'
        ].forEach((key, index) => {
          if (flags[index] === undefined) delete process.env[key];
          else process.env[key] = flags[index];
        });
      }
    });

    it('runs a budgeted transaction at READ COMMITTED when asked and REPEATABLE READ by default', async () => {
      const name = () =>
        sqlExecutor.oneOrNull<{ name: string }>(
          'select name from waves where id = :id',
          { id: wave.id }
        );
      const readTwice = (readCommittedLevel: boolean) =>
        withRequestDeadline(30_000, () =>
          runWriteTransaction((options) =>
            sqlExecutor.executeNativeQueriesInTransaction(
              async (connection) => {
                const read = () =>
                  sqlExecutor
                    .oneOrNull<{
                      name: string;
                    }>('select name from waves where id = :id', { id: wave.id }, { wrappedConnection: connection })
                    .then((row) => row?.name);
                const first = await read();
                // Another session commits a change in between.
                await sqlExecutor.execute(
                  'update waves set name = :name where id = :id',
                  { id: wave.id, name: `${first}-changed` }
                );
                return [first, await read()];
              },
              readCommittedLevel ? readCommitted(options) : options
            )
          )
        );
      const original = (await name())?.name;
      const [rcFirst, rcSecond] = await readTwice(true);
      expect(rcFirst).toBe(original);
      expect(rcSecond).toBe(`${original}-changed`);
      const [rrFirst, rrSecond] = await readTwice(false);
      expect(rrFirst).toBe(`${original}-changed`);
      expect(rrSecond).toBe(rrFirst);
    });

    it('runs a real drop delete under the READ COMMITTED budget', async () => {
      const created = await budgetedPost(chatDrop('to delete'));
      await withRequestDeadline(30_000, () =>
        reactionsService.addReaction(created.drop_id, reactor, ':fire:', {
          authenticationContext: AuthenticationContext.fromProfileId(reactor)
        })
      );
      await withRequestDeadline(30_000, () =>
        runWriteTransaction((options) =>
          sqlExecutor.executeNativeQueriesInTransaction(
            (connection) =>
              deleteDrop.execute(
                {
                  drop_id: created.drop_id,
                  deleter_identity: author,
                  deleter_id: author,
                  deletion_purpose: 'DELETE'
                },
                { timer: new Timer('test'), connection }
              ),
            readCommitted(options)
          )
        )
      );
      const left = await sqlExecutor.oneOrNull<{ n: number }>(
        `select count(*) as n from ${DROPS_TABLE} where id = :id`,
        { id: created.drop_id }
      );
      expect(Number(left?.n)).toBe(0);
    });

    it('reads back the same drop after commit as inside the transaction', async () => {
      let inside: unknown;
      const result = await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const created = await createOrUpdateDrop.execute(
            chatDrop('read back'),
            false,
            { connection, prePublication: { trustedSystem: true } }
          );
          inside = await dropsService.findDropByIdOrThrow(
            { dropId: created.drop_id, skipEligibilityCheck: true },
            {
              connection,
              authenticationContext: AuthenticationContext.fromProfileId(author)
            }
          );
          return created;
        }
      );
      const after = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          dropsService.findDropByIdOrThrow(
            { dropId: result.drop_id, skipEligibilityCheck: true },
            {
              connection,
              authenticationContext: AuthenticationContext.fromProfileId(author)
            }
          )
      );
      // The wave's counters (wave_metrics) are applied after commit (#2370),
      // so only the wave's last drop time may be newer after commit.
      const { wave: afterWave, ...afterRest } = after as {
        wave: { last_drop_time: number };
      };
      const { wave: insideWave, ...insideRest } = inside as {
        wave: { last_drop_time: number };
      };
      expect(afterRest).toEqual(insideRest);
      expect({ ...afterWave, last_drop_time: 0 }).toEqual({
        ...insideWave,
        last_drop_time: 0
      });
      expect(afterWave.last_drop_time).toBeGreaterThanOrEqual(
        insideWave.last_drop_time
      );
    });

    it('gives up a lock wait after 10 s with 503 + Retry-After and leaves no open transaction', async () => {
      const holder = holdWaveRow();
      await holder.isLocked;
      const threadIds: number[] = [];
      const started = performance.now();
      try {
        const error = await budgetedWaveRowWrite(30_000, threadIds).catch(
          (e: unknown) => e
        );
        const waited = performance.now() - started;
        expect(error).toBeInstanceOf(WriteBusyException);
        expect((error as WriteBusyException).getStatusCode()).toBe(503);
        expect((error as WriteBusyException).retryAfterSeconds).toBe(2);
        expect(waited).toBeGreaterThanOrEqual(9_500);
        expect(waited).toBeLessThan(14_000);
        expect(await openTransactionsOf(threadIds[0])).toBe(0);
      } finally {
        holder.release();
        await holder.done;
      }
    });

    it('rolls the transaction back at the request deadline with 503', async () => {
      const holder = holdWaveRow();
      await holder.isLocked;
      const threadIds: number[] = [];
      const started = performance.now();
      try {
        // 8 s left in the Lambda: the write deadline is 3 s away, well
        // before the 10 s lock wait would give up.
        const error = await budgetedWaveRowWrite(8_000, threadIds).catch(
          (e: unknown) => e
        );
        const waited = performance.now() - started;
        expect(error).toBeInstanceOf(WriteBusyException);
        expect(waited).toBeLessThan(5_000);
        // The connection was cut off mid lock wait (no KILL): the server
        // ends its transaction within the 10 s lock-wait limit.
        expect(await untilNoOpenTransaction(threadIds[0])).toBeLessThan(10_500);
      } finally {
        holder.release();
        await holder.done;
      }
    });

    it('answers at once when the deadline has already passed', async () => {
      await expect(
        withRequestDeadline(5_500, () =>
          runWriteTransaction(() => Promise.resolve('never'))
        )
      ).rejects.toBeInstanceOf(WriteBusyException);
    });

    it('leaves transactions outside a request unbudgeted', async () => {
      const options: unknown[] = [];
      await runWriteTransaction(async (o) => {
        options.push(o);
      });
      expect(options).toEqual([undefined]);
    });
  }
);
